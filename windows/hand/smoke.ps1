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
if (!before.accessibility?.tree) throw new Error("UI Automation returned no Notepad tree");
const shot = before.screenshots[0];
await cua.computer.click({window, x:Math.max(1, Math.floor(shot.width / 2)), y:Math.max(1, Math.floor(shot.height / 2))});
await cua.computer.type_text({window, text:"$marker"});
const after = await cua.computer.get_window_state({window, include_screenshot:true, include_text:true});
if (!after.accessibility?.tree) throw new Error("UI Automation returned no updated Notepad tree");
if (!after.screenshots?.length || after.screenshots[0].url === shot.url) throw new Error("Windows Graphics Capture did not observe typed input");
nodeRepl.write(JSON.stringify({target:cua.computer.target, window:window.id, screenshots:before.screenshots.length + after.screenshots.length, typed:true, accessibility:true}));
"@
    $receiptPath = Join-Path $env:RUNNER_TEMP "nanocodex-windows-hand-smoke.json"
    & $Computer --allow-native-control eval --code $code --timeout 45 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) {
        throw "Windows computer-control smoke test failed"
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw
    if ($receipt -notlike '*"target":"windows"*' -or $receipt -notlike '*"typed":true*' -or $receipt -notlike '*"accessibility":true*') {
        throw "Windows computer-control smoke receipt is incomplete: $receipt"
    }
    Write-Host "Windows Hand controlled and observed a real Notepad window through WGC and UIA."
} finally {
    if (-not $notepad.HasExited) {
        Stop-Process -Id $notepad.Id -Force
    }
}
