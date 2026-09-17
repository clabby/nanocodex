[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Computer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$marker = "nanocodex-windows-hand-smoke-$([Guid]::NewGuid().ToString('N'))"
$document = Join-Path $env:TEMP "$marker.txt"
$script = Join-Path $env:TEMP "$marker.js"
Set-Content -LiteralPath $document -Value "Nanocodex smoke test" -Encoding UTF8
Start-Process -FilePath "$env:SystemRoot\System32\notepad.exe" -ArgumentList ('"' + $document + '"') | Out-Null
try {
    $code = @"
await __skyreInitialize();
let window;
for (let attempt = 0; attempt < 60; attempt++) {
    const windows = await cua.computer.list_windows();
    window = windows.find(row => row.title.includes("$marker"));
    if (window) break;
    await new Promise(resolve => setTimeout(resolve, 250));
}
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
await cua.computer.press_key({window, key:"CTRL+S"});
await cua.computer.press_key({window, key:"ALT+F4"});
nodeRepl.write(JSON.stringify({target:cua.computer.target, window:window.id, screenshots:before.screenshots.length + after.screenshots.length, typed:true, accessibility:true}));
"@
    $receiptPath = Join-Path $env:RUNNER_TEMP "nanocodex-windows-hand-smoke.json"
    [IO.File]::WriteAllText($script, $code)
    & $Computer --allow-native-control eval --file $script --timeout 45 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) {
        throw "Windows computer-control smoke test failed"
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw
    try {
        $envelope = $receipt | ConvertFrom-Json
        $write = $envelope.outputs |
            Where-Object { $_.kind -eq "write" } |
            Select-Object -Last 1
        $proof = $write.value | ConvertFrom-Json
    } catch {
        throw "Windows computer-control smoke test returned an invalid receipt."
    }
    if ($proof.target -ne "windows" -or $proof.typed -ne $true -or $proof.accessibility -ne $true) {
        throw "Windows computer-control smoke receipt is incomplete."
    }
    Write-Host "Windows Hand controlled and observed a real Notepad window through WGC and UIA."
} finally {
    Remove-Item -LiteralPath $document, $script -Force -ErrorAction SilentlyContinue
}
