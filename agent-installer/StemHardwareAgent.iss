; StemEducatorApp Hardware Agent - standalone installer
; Bundles a portable Node.js runtime so end users don't need Node.js
; installed at all - no manual zip extraction, no npm install step.
; Build: install Inno Setup 6, then run:
;   iscc agent-installer\StemHardwareAgent.iss
; Output: agent-installer\Output\StemHardwareAgent-Setup.exe

#define MyAppName "StemEducatorApp Hardware Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "StemEducatorApp"
#define MyAppExeName "run-agent.bat"

[Setup]
AppId={{6C8F1E9B-2A47-4D3E-9C11-STEMHWAGENT01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install (AppData) - no admin rights required, since the people
; running this are often students/teachers on locked-down school machines.
DefaultDirName={autopf}\{#MyAppName}
PrivilegesRequired=lowest
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=Output
OutputBaseFilename=StemHardwareAgent-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\build\favicon.ico
UninstallDisplayIcon={app}\node-runtime\node.exe
DisableProgramGroupPage=no
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "staging\node-runtime\node.exe"; DestDir: "{app}\node-runtime"; Flags: ignoreversion
Source: "staging\run-agent.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\agent\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\agent\firmware\*"; DestDir: "{app}\firmware"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\agent\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Start the Hardware Agent now"; Flags: postinstall nowait skipifsilent runascurrentuser
