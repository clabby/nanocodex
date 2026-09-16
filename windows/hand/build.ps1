[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Nanocodex2,

    [Parameter(Mandatory = $true)]
    [string]$Computer,

    [string]$Version = "dev",

    [string]$NumericVersion = "0.0.0.0"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $root "payload"
$output = Join-Path (Split-Path -Parent (Split-Path -Parent $root)) "dist\windows-hand"
$compiler = Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "Inno Setup 6 is required: $compiler"
}
foreach ($path in @($Nanocodex2, $Computer)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing Windows Hand payload: $path"
    }
}

New-Item -ItemType Directory -Force -Path $payload, $output | Out-Null
Copy-Item -LiteralPath $Nanocodex2 -Destination (Join-Path $payload "nanocodex2.exe") -Force
Copy-Item -LiteralPath $Computer -Destination (Join-Path $payload "nanocodex-computer.exe") -Force

try {
    & $compiler "/DAppVersion=$Version" "/DNumericVersion=$NumericVersion" (Join-Path $root "installer.iss")
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup failed with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -LiteralPath $payload -Recurse -Force -ErrorAction SilentlyContinue
}

$installer = Join-Path $output "nanocodex-hand-setup-x86_64.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer was not created: $installer"
}
Write-Output $installer
