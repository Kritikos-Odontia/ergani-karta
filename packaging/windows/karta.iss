; SPDX-License-Identifier: EUPL-1.2
; THE WINDOWS INSTALLER (Inno Setup 6), built by .github/workflows/release.yml from the staged folder:
;   KartaErgasias.exe (packaging/windows/Starter.cs), node.exe, launcher.mjs, app\, licenses\
; Installed once, for the computer (administrator ONCE): the program in Program Files (always there — no folder page, and
; never an earlier install's other folder: only an administrator may change the runtime the firewall trusts), a Start-menu and desktop icon, the sign-in start
; for every user, and the firewall rules for the program's own Node.js (the one every version runs on — launcher.ts
; runtimeFor): port 8880 open on PRIVATE and DOMAIN networks from the local network only, so phones on the practice
; Wi-Fi reach it, and closed on PUBLIC ones (a guest network) — a rule for each, so Windows never asks «allow this app?»
; (an unanswered ask blocks the staff page). Before ours are added, EVERY inbound rule for exactly these program paths is
; removed, whoever made it (Windows by itself, or someone by hand): older per-version copies —
; `…\AppData\Local\Karta Ergasias\versions\<x.y.z>\node.exe` — and `{app}\node.exe`; no other program's, no outbound one. The data stays per user and is NEVER removed by the uninstaller: it is the employer's
; five-year record. Updates need no installer and no administrator — except a release on a new Node.js line, which comes
; as a new installer (updater.ts).
#define AppVersion GetEnv("KARTA_VERSION")
#define Stage GetEnv("KARTA_STAGE")

[Setup]
AppId={{7C1E2F4A-5B3D-4E8A-9C6F-2D1B0A9E8F71}
AppName=Κάρτα Εργασίας
AppVersion={#AppVersion}
AppPublisher=Odontia
AppPublisherURL=https://odontia.ai
DefaultDirName={autopf}\Karta Ergasias
DefaultGroupName=Κάρτα Εργασίας
DisableProgramGroupPage=yes
DisableDirPage=yes
UsePreviousAppDir=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=karta-ergasias-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\KartaErgasias.exe
UninstallDisplayName=Κάρτα Εργασίας

[Languages]
; Greek.isl: Inno Setup's own Greek translation, put beside this file by the release workflow (pinned, checked).
Name: "greek"; MessagesFile: "Greek.isl"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Κάρτα Εργασίας"; Filename: "{app}\KartaErgasias.exe"
Name: "{autodesktop}\Κάρτα Εργασίας"; Filename: "{app}\KartaErgasias.exe"

[Registry]
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "KartaErgasias"; ValueData: """{app}\KartaErgasias.exe"" --background"; Flags: uninsdeletevalue

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Karta Ergasias 8880"""; Flags: runhidden
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -match '\\AppData\\Local\\Karta Ergasias\\versions\\\d+\.\d+\.\d+\\node\.exe$' -or $_.Program -eq '{app}\node.exe' } | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Karta Ergasias 8880"" dir=in action=allow program=""{app}\node.exe"" protocol=TCP localport=8880 profile=private,domain remoteip=localsubnet"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Karta Ergasias 8880"" dir=in action=block program=""{app}\node.exe"" profile=public"; Flags: runhidden
Filename: "{app}\KartaErgasias.exe"; Description: "Άνοιγμα της Κάρτας Εργασίας"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM KartaErgasias.exe"; Flags: runhidden; RunOnceId: "StopKarta"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Karta Ergasias 8880"""; Flags: runhidden; RunOnceId: "FirewallRule"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -match '\\AppData\\Local\\Karta Ergasias\\versions\\\d+\.\d+\.\d+\\node\.exe$' -or $_.Program -eq '{app}\node.exe' } | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule"""; Flags: runhidden; RunOnceId: "StaleRules"

[Code]
// A program already running holds node.exe: stop it before its files are replaced (an installer over an older one).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM KartaErgasias.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('Το πρόγραμμα αφαιρέθηκε. Το αρχείο σας (κάρτες, προσωπικό, αντίγραφα) ΔΕΝ σβήστηκε: είναι στον φάκελο' + #13#10 +
      ExpandConstant('{localappdata}') + '\Karta Ergasias' + #13#10 +
      'Κρατήστε το πέντε χρόνια — είναι υποχρέωση του εργοδότη.', mbInformation, MB_OK);
end;
