[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,

    [Parameter(Mandatory = $true)]
    [string]$Workspace,

    [Parameter(Mandatory = $true)]
    [string]$DataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$binary = Join-Path $InstallDir "nanocodex2.exe"
$computer = Join-Path $InstallDir "nanocodex-computer.exe"
$state = Join-Path $DataDir "state"
$log = Join-Path $DataDir "hand.log"
$account = Join-Path $DataDir "account.json"

foreach ($path in @($binary, $computer)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Nanocodex Hand is incomplete: missing $path"
    }
}

New-Item -ItemType Directory -Force -Path $Workspace, $DataDir, $state | Out-Null
$env:NANOCODEX_ACCOUNT_FILE = $account

& $binary native-hand `
    --workspace $Workspace `
    --state-dir $state `
    --machine-name $env:COMPUTERNAME `
    --log-format json `
    --log-file $log
exit $LASTEXITCODE
