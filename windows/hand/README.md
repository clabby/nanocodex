# Windows Hand

`nanocodex-hand-setup-x86_64.exe` is the consumer installer for an x86-64
Windows 10 or 11 computer.

1. Download and double-click the installer.
2. Leave **Sign in and connect this computer now** checked.
3. Enter the account phone number and the six-digit SMS code.

The installer is per-user and does not need administrator access. It verifies
both bundled executables, stores a dedicated account credential under
`%LOCALAPPDATA%\Nanocodex\Hand`, and registers an interactive scheduled task.
The task runs only while that Windows user is signed in, starts again at logon,
restarts after failures, and uses outbound HTTPS. Interactive startup is
required for Windows Graphics Capture, UI Automation, and input injection;
a Session 0 Windows service cannot control the signed-in desktop.

The Start menu contains shortcuts to stop the Hand, start or repair it, inspect
its logs, or uninstall it. Uninstalling removes the scheduled task, retained
machine identity, logs, and the installer's dedicated account credential.

The Hand publishes the user's profile as its native workspace. Computer use is
authorized by the account-scoped Hand attachment and remains subject to the
agent's normal confirmation policy. Locking or signing out of Windows prevents
interactive desktop control; **Stop Nanocodex Hand** pauses the connection while
remaining signed in.

## Build

Build `nanocodex2.exe` from the main workspace and `nanocodex-computer.exe` from
`crates/experimental/nanocodex-computer/runtime`, then run:

```powershell
.\windows\hand\build.ps1 `
  -Nanocodex2 .\target\release\nanocodex2.exe `
  -Computer .\crates\experimental\nanocodex-computer\runtime\target\release\nanocodex-computer.exe `
  -Version 0.6.1
```

Inno Setup 6 produces `dist\windows-hand\nanocodex-hand-setup-x86_64.exe`.
Release automation signs the payload and installer when the repository's
Authenticode certificate secrets are configured.
