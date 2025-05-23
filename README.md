# Filesystem MCP Server

Node.js server implementing Model Context Protocol (MCP) for filesystem operations.

This repository is a fork of [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
with everything removed except for the filesystem server.

This fork introduces better **Windows** compatibility and a few other improvements.

## Features

- Read/write files
- Create/list/delete directories
- Move files/directories
- Search files
- Get file metadata
- Allow only certain tools to be used

**Note**: The server will only allow operations within directories specified via `args`.

## API

### Resources

- `file://system`: File system operations interface

### Tools

- **read_file**
    - Read complete contents of a file
    - Input: `path` (string)
    - Reads complete file contents with UTF-8 encoding

- **read_multiple_files**
    - Read multiple files simultaneously
    - Inputs:
        - `paths` (string[]): List of file paths or glob patterns
        - `basePath` (string, optional): Base path to prepend to each path in the paths array
    - Automatically detects and expands glob patterns (paths containing *, ?, [, ], {, }, !)
    - Supports glob patterns like `*.js` or `src/**/*.ts`
    - Works with Windows paths
    - Failed reads won't stop the entire operation

- **write_file**
    - Create new file or overwrite existing (exercise caution with this)
    - Inputs:
        - `path` (string): File location
        - `content` (string): File content

- **edit_file**
    - Make selective edits using advanced pattern matching and formatting
    - Features:
        - Line-based and multi-line content matching
        - Whitespace normalization with indentation preservation
        - Multiple simultaneous edits with correct positioning
        - Indentation style detection and preservation
        - Git-style diff output with context
        - Preview changes with dry run mode
    - Inputs:
        - `path` (string): File to edit
        - `edits` (array): List of edit operations
            - `oldText` (string): Text to search for (can be substring)
            - `newText` (string): Text to replace with
        - `dryRun` (boolean): Preview changes without applying (default: false)
    - Returns detailed diff and match information for dry runs, otherwise applies changes
    - Best Practice: Always use dryRun first to preview changes before applying them

- **create_directory**
    - Create new directory or ensure it exists
    - Input: `path` (string)
    - Creates parent directories if needed
    - Succeeds silently if directory exists

- **list_directory**
    - List directory contents with [FILE] or [DIR] prefixes
    - Input: `path` (string)

- **move_file**
    - Move or rename files and directories
    - Inputs:
        - `source` (string)
        - `destination` (string)
    - Fails if destination exists

- **search_files**
    - Recursively search for files/directories
    - Inputs:
        - `path` (string): Starting directory
        - `pattern` (string): Search pattern
        - `excludePatterns` (string[]): Exclude any patterns. Glob formats are supported.
    - Case-insensitive matching
    - Returns full paths to matches

- **get_file_info**
    - Get detailed file/directory metadata
    - Input: `path` (string)
    - Returns:
        - Size
        - Creation time
        - Modified time
        - Access time
        - Type (file/directory)
        - Permissions

- **list_allowed_directories**
    - List all directories the server is allowed to access
    - No input required
    - Returns:
        - Directories that this server can read/write from

## Usage with Windsurf IDE on Windows

Add this to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@matj.dev/filesystem-mcp",
        "--tools",
        "read_file,read_multiple_files",
        "C:\\Projects"
      ]
    }
  }
}
```

Then on your `global_rules.md`, instruct Windsurf to use the MCP server:

```markdown
# Tools

- When reading files use the  `read_file` tool from the filesystem MCP.
- When reading multiple files use the `read_multiple_files` tool from the filesystem MCP
```

## Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

Note: you can provide sandboxed directories to the server by mounting them to `/projects`.
Adding the `ro` flag will make the directory readonly by the server.

### Windows

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@matj.dev/filesystem-mcp",
        "--tools",
        "read_file,read_multiple_files",
        "C:\\Projects",
        "\"C:\\usr\\a b\""
      ]
    }
  }
}
```

### Docker

Note: all directories must be mounted to `/projects` by default.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--mount", "type=bind,src=/Users/username/Desktop,dst=/projects/Desktop",
        "--mount", "type=bind,src=/path/to/other/allowed/dir,dst=/projects/other/allowed/dir,ro",
        "--mount", "type=bind,src=/path/to/file.txt,dst=/projects/path/to/file.txt",
        "mcp/filesystem",
        "/projects"
      ]
    }
  }
}
```

### NPX

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@matj.dev/filesystem-mcp",
        "--tools",
        "read_file,read_multiple_files",
        "/Users/username/Desktop",
        "/path/to/other/allowed/dir"
      ]
    }
  }
}
```

## Build

Docker build:

```bash
docker build .
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify,
and distribute the software, subject to the terms and conditions of the MIT License. For
more details, please see the LICENSE file in the project repository.
