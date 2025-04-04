param(
    [Parameter(ParameterSetName='Major')][switch]$Major,
    [Parameter(ParameterSetName='Minor')][switch]$Minor,
    [Parameter(ParameterSetName='Middle')][switch]$Middle
)

# Define variables
$packageJsonPath = "package.json"
$tempJsonPath = "tmp.json"

# Determine which version number to bump
if ($Major) {
    $versionPart = 0
} elseif ($Middle) {
    $versionPart = 1
} elseif ($Minor) {
    $versionPart = 2
} else {
    Write-Error "Please specify one of -Major, -Middle, or -Minor"
    exit 1
}

# Bump the specified version number
jq ".version |= (split(""."") | .[$versionPart] = ((.[$versionPart] | tonumber) + 1 | tostring) | join("".""))" `
  $packageJsonPath > $tempJsonPath

# Replace the original package.json with the updated version
Move-Item -Force $tempJsonPath $packageJsonPath

# Run the version script
npm run version

# Get the new version number
$newVersion = jq --raw-output '.version' $packageJsonPath

# Git operations
git add *
git commit -m "chore: update changelog and bump version to $newVersion"
git tag $newVersion HEAD
