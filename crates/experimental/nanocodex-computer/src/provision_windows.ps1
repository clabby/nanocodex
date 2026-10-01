# Windows upstream CUA is intentionally unsupported until the signed native
# helper's no-Codex policy contract is verified. Do not install a desktop app,
# copy all companion executables, advertise browser APIs, or reuse a legacy
# receipt. This failure occurs before any installation or filesystem mutation.
$ErrorActionPreference = 'Stop'
throw 'Windows upstream CUA is unsupported: the native helper policy contract without Codex has not been verified. No installation or configuration was changed.'
