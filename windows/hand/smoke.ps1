[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Computer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$marker = "nanocodex-windows-hand-smoke-$([Guid]::NewGuid().ToString('N'))"
$notepad = Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $notepad.Refresh()
    } while ($notepad.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($notepad.MainWindowHandle -eq 0) {
        throw "Notepad did not create a visible window"
    }

    $code = @"
await __skyreInitialize();
const windows = await cua.computer.list_windows();
const window = windows.find(row => row.id === $($notepad.MainWindowHandle.ToInt64()));
if (!window) throw new Error("Notepad window was not discovered through Win32");
const before = await cua.computer.get_window_state({window, include_screenshot:true, include_text:true});
if (!before.screenshots?.length) throw new Error("Windows Graphics Capture returned no screenshot");
const editor = before.accessibility?.tree?.match(/^\s*(\d+) text (?:entry area|field)\b/m);
if (!editor) throw new Error("UI Automation did not discover the Notepad editor");
await cua.computer.click({window, element_index:Number(editor[1])});
await cua.computer.type_text({window, text:"$marker"});
const after = await cua.computer.get_window_state({window, include_screenshot:false, include_text:true});
if (!after.accessibility?.tree?.includes("$marker")) throw new Error("UI Automation did not observe typed input");
nodeRepl.write(JSON.stringify({target:cua.computer.target, window:window.id, screenshots:before.screenshots.length, typed:true}));
"@
    $receiptPath = Join-Path $env:RUNNER_TEMP "nanocodex-windows-hand-smoke.json"
    & $Computer --allow-native-control eval --code $code --timeout 45 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) {
        throw "Windows computer-control smoke test failed"
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw
    if ($receipt -notlike '*"target":"windows"*' -or $receipt -notlike '*"typed":true*') {
        throw "Windows computer-control smoke receipt is incomplete: $receipt"
    }
    Write-Host "Windows Hand controlled, captured, and read back a real Notepad window."
} finally {
    if (-not $notepad.HasExited) {
        Stop-Process -Id $notepad.Id -Force
    }
}
