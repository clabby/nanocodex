#ifndef AppVersion
  #define AppVersion "dev"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif

#define AppName "Nanocodex Hand"
#define AppPublisher "Nanocodex"

[Setup]
AppId={{4B87C5CE-A499-4CB9-AE58-11E7BB87C79C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/gakonst/nanocodex
AppSupportURL=https://github.com/gakonst/nanocodex/issues
DefaultDirName={localappdata}\Programs\Nanocodex Hand
DefaultGroupName=Nanocodex Hand
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
OutputDir=..\..\dist\windows-hand
OutputBaseFilename=nanocodex-hand-setup-x86_64
UninstallDisplayName=Nanocodex Hand
VersionInfoVersion={#NumericVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Nanocodex Windows Hand installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "greek"; MessagesFile: "compiler:Languages\Greek.isl"

[Files]
Source: "payload\nanocodex2.exe"; DestDir: "{app}"; Flags: ignoreversion replacesameversion
Source: "payload\nanocodex-computer.exe"; DestDir: "{app}"; Flags: ignoreversion replacesameversion
Source: "run-hand.ps1"; DestDir: "{app}"; Flags: ignoreversion replacesameversion
Source: "setup-hand.ps1"; DestDir: "{app}"; Flags: ignoreversion replacesameversion

[Icons]
Name: "{group}\Start or repair Nanocodex Hand"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-hand.ps1"" -Action Repair -InstallDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\Stop Nanocodex Hand"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-hand.ps1"" -Action Stop -InstallDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\Nanocodex Hand logs"; Filename: "{localappdata}\Nanocodex\Hand"; Flags: foldershortcut
Name: "{group}\Uninstall Nanocodex Hand"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-hand.ps1"" -Action Install -InstallDir ""{app}"""; Description: "Sign in and connect this computer now"; Flags: postinstall waituntilterminated skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\setup-hand.ps1"" -Action Uninstall -InstallDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveNanocodexHandTask"

[Messages]
WelcomeLabel2=This installs a personal Nanocodex Hand for the current Windows user.%n%nAfter installation, sign in with a phone number and the six-digit SMS code. The Hand then starts automatically whenever this user signs in and can control this user's apps and files through the connected Nanocodex account.

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  SetupScript: String;
  Arguments: String;
begin
  Result := '';
  SetupScript := ExpandConstant('{app}\setup-hand.ps1');
  if FileExists(SetupScript) then
  begin
    Arguments := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      SetupScript + '" -Action Stop -InstallDir "' + ExpandConstant('{app}') + '"';
    if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
      (ResultCode <> 0) then
      Result := 'Could not stop the existing Nanocodex Hand. Close it and try again.';
  end;
end;
