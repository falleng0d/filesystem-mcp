#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { glob } from 'glob';

// Valid tools schema
const ValidToolSchema = z.string().refine((tool) => {
  const validTools = [
    "read_file",
    "read_multiple_files",
    "write_file",
    "edit_file",
    "create_directory",
    "list_directory",
    "directory_tree",
    "move_file",
    "search_files",
    "get_file_info",
    "list_allowed_directories",
  ];

  return validTools.includes(tool);
}, "Invalid tool name");

// Command line argument parsing
const args = process.argv.slice(2);
const directoryArgs: string[] = [];
let allowedTools: string[] = [];

// Process arguments
let i = 0;
while (i < args.length) {
  if (args[i] === "--tools") {
    if (i + 1 < args.length) {
      // Parse comma-separated list of tools
      allowedTools = args[i + 1].split(',').map(tool => tool.trim());
      // Validate each tool
      const invalidTools = allowedTools.filter(tool => !ValidToolSchema.safeParse(tool).success);
      if (invalidTools.length > 0) {
        console.error(`Error: Invalid tools specified: ${invalidTools.join(', ')}`);
        process.exit(1);
      }
      i += 2; // Skip both the flag and its value
    } else {
      console.error("Error: --tools flag requires a comma-separated list of tool names");
      process.exit(1);
    }
  } else {
    // Treat as a directory path
    directoryArgs.push(args[i]);
    i++;
  }
}

if (directoryArgs.length === 0) {
  console.error("Usage: mcp-server-filesystem --tools [tools...] <allowed-directory> [additional-directories...]");
  console.error("       [tools...] is an optional comma-separated list of tools (e.g., read_file,write_file,...)");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath.startsWith('~\\') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = directoryArgs.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(directoryArgs.map(async (dir) => {
  try {
    const stats = await fs.stat(expandHome(dir));
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  if (os.platform() === 'win32' && /^[a-zA-Z]:/.test(requestedPath)) {
    const driveLetter = requestedPath.charAt(0).toUpperCase();
    const restOfPath = requestedPath.slice(1);
    requestedPath = driveLetter + restOfPath;
  }

  const expandedPath = expandHome(requestedPath);

  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
  basePath: z.string().optional().default('')
    .describe('Base path to prepend to each file path'),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Server setup
const server = new Server(
  {
    name: "secure-filesystem-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations

// Helper function to check if a path contains glob patterns
// Checks for common glob characters: *, ?, [, ], {, }, !
function isGlobPattern(filePath: string): boolean {
  return /[*?\[\]{}!]/.test(filePath);
}

async function expandGlobPatterns(patterns: string[], basePath: string): Promise<string[]> {
  const allFiles: string[] = [];

  for (const pattern of patterns) {
    let normalizedPattern = pattern;
    let baseDirForGlob = basePath ? basePath : process.cwd();

    if (os.platform() === 'win32' && /^[a-zA-Z]:/.test(pattern)) {
      const driveLetter = pattern.charAt(0).toUpperCase() + ':' + path.sep;
      baseDirForGlob = driveLetter + path.sep;

      normalizedPattern = pattern.slice(2);
      if (normalizedPattern.startsWith(path.sep)) {
        normalizedPattern = normalizedPattern.slice(1);
      }
    } else if (path.isAbsolute(pattern)) {
      baseDirForGlob = path.parse(pattern).root;
      normalizedPattern = pattern.slice(baseDirForGlob.length);
    }

    const matches = await glob(normalizedPattern, {
      absolute: true,
      cwd: baseDirForGlob,
      dot: true,
      nodir: true,
      windowsPathsNoEscape: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/vendor/**'],
    });

    for (const match of matches) {
      await validatePath(match);
      allFiles.push(match);
    }
  }

  return allFiles;
}

async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        // Validate each path before processing
        await validatePath(fullPath);

        // Check if path matches any exclude pattern
        const relativePath = path.relative(rootPath, fullPath);
        const shouldExclude = excludePatterns.some(pattern => {
          const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
          return minimatch(relativePath, globPattern, { dot: true });
        });

        if (shouldExclude) {
          continue;
        }

        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

// Tool handlers
let tools = [
  {
    name: "read_file",
    description:
      "Read the complete contents of a file from the file system. " +
      "Handles various text encodings and provides detailed error messages " +
      "if the file cannot be read. Use this tool when you need to examine " +
      "the contents of a single file.",
    inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
  },
  {
    name: "read_multiple_files",
    description:
      "Read the contents of multiple files simultaneously. This is more " +
      "efficient than reading files one by one when you need to analyze " +
      "or compare multiple files. Each file's content is returned with its " +
      "path as a reference. Failed reads for individual files won't stop " +
      "the entire operation. Supports glob patterns - any path " +
      "containing *, ?, [, ], {, }, or ! characters will be treated as a glob pattern, " +
      "allowing you to match multiple files with wildcards like *.js or src/**/*.ts. " +
      "Optionally accepts a basePath parameter that will be prepended to each path in the paths array.",
    inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
  },
  {
    name: "write_file",
    description:
      "Create a new file or completely overwrite an existing file with new content. " +
      "Use with caution as it will overwrite existing files without warning. " +
      "Handles text content with proper encoding.",
    inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
  },
  {
    name: "edit_file",
    description:
      "Make line-based edits to a text file. Each edit replaces exact line sequences " +
      "with new content. Returns a git-style diff showing the changes made. " +
      "Only works within allowed directories.",
    inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
  },
  {
    name: "create_directory",
    description:
      "Create a new directory or ensure a directory exists. Can create multiple " +
      "nested directories in one operation. If the directory already exists, " +
      "this operation will succeed silently. Perfect for setting up directory " +
      "structures for projects or ensuring required paths exist.",
    inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
  },
  {
    name: "list_directory",
    description:
      "Get a detailed listing of all files and directories in a specified path. " +
      "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
      "prefixes. This tool is essential for understanding directory structure and " +
      "finding specific files within a directory.",
    inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
  },
  {
    name: "directory_tree",
    description:
      "Get a recursive tree view of files and directories as a JSON structure. " +
      "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
      "Files have no children array, while directories always have a children array (which may be empty). " +
      "The output is formatted with 2-space indentation for readability.",
    inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
  },
  {
    name: "move_file",
    description:
      "Move or rename files and directories. Can move files between directories " +
      "and rename them in a single operation. If the destination exists, the " +
      "operation will fail. Works across different directories and can be used " +
      "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
    inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
  },
  {
    name: "search_files",
    description:
      "Recursively search for files and directories matching a pattern. " +
      "Searches through all subdirectories from the starting path. The search " +
      "is case-insensitive and matches partial names. Returns full paths to all " +
      "matching items. Great for finding files when you don't know their exact location. ",
    inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
  },
  {
    name: "get_file_info",
    description:
      "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
      "information including size, creation time, last modified time, permissions, " +
      "and type. This tool is perfect for understanding file characteristics " +
      "without reading the actual content.",
    inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
  },
  {
    name: "list_allowed_directories",
    description:
      "Returns the list of directories that this server is allowed to access. " +
      "Use this to understand which directories are available before trying to access files.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

if (allowedTools.length > 0) {
  const filteredTools = tools.filter(tool => allowedTools.includes(tool.name));
  if (filteredTools.length === 0) {
    console.error("Error: No valid tools found in the specified list.");
    process.exit(1);
  }

  tools = filteredTools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await fs.readFile(validPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
        }

        // Get the base path if provided
        const basePath = parsed.data.basePath || '';

        // Separate glob patterns from regular paths
        const globPatterns: string[] = [];
        const regularPaths: string[] = [];

        // Automatically detect glob patterns by the presence of glob characters
        for (const filePath of parsed.data.paths) {
          // Prepend base path if it exists
          const fullPath = basePath ? path.join(basePath, filePath) : filePath;

          if (isGlobPattern(fullPath)) {
            globPatterns.push(fullPath);
          } else {
            regularPaths.push(fullPath);
          }
        }

        // Collect all paths to process
        let filePaths: string[] = [...regularPaths];

        // Process glob patterns, if any, exist
        if (globPatterns.length > 0) {
          const expandedPaths = await expandGlobPatterns(globPatterns, basePath);
          filePaths = [...filePaths, ...expandedPaths];

          // If no files matched the glob patterns, return a warning
          if (expandedPaths.length === 0 && regularPaths.length === 0) {
            return {
              content: [{ type: "text", text: "No files matched the provided glob patterns" }],
              isError: true,
            };
          }
        }

        const results = await Promise.all(
          filePaths.map(async (filePath: string) => {
            try {
              // For regular paths, we need to validate them
              // Paths from glob expansion are already validated
              const isFromGlob = !regularPaths.includes(filePath);
              const validPath = isFromGlob ? filePath : await validatePath(filePath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          }),
        );

        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.writeFile(validPath, parsed.data.content, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }

      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.mkdir(validPath, { recursive: true });
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

        case "directory_tree": {
            const parsed = DirectoryTreeArgsSchema.safeParse(args);
            if (!parsed.success) {
                throw new Error(`Invalid arguments for directory_tree: ${parsed.error}`);
            }

            interface TreeEntry {
                name: string;
                type: 'file' | 'directory';
                children?: TreeEntry[];
            }

            async function buildTree(currentPath: string): Promise<TreeEntry[]> {
                const validPath = await validatePath(currentPath);
                const entries = await fs.readdir(validPath, {withFileTypes: true});
                const result: TreeEntry[] = [];

                for (const entry of entries) {
                    const entryData: TreeEntry = {
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file'
                    };

                    if (entry.isDirectory()) {
                        const subPath = path.join(currentPath, entry.name);
                        entryData.children = await buildTree(subPath);
                    }

                    result.push(entryData);
                }

                return result;
            }

            const treeData = await buildTree(parsed.data.path);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(treeData, null, 2)
                }],
            };
        }

      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await fs.rename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{ type: "text", text: Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n") }],
        };
      }

      case "list_allowed_directories": {
        return {
          content: [{
            type: "text",
            text: `Allowed directories:\n${allowedDirectories.join('\n')}`
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP Filesystem Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
