# Hardware Agent Installer

Builds `StemHardwareAgent-Setup-<version>.exe` - a standalone Windows
installer for the hardware agent (`agent/`) that bundles its own portable
Node.js runtime. End users don't need Node.js installed and don't need to
manually extract a zip or run `npm install` - just run the installer.

## One-time setup

1. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php) (or `winget install --id JRSoftware.InnoSetup -e`).
2. Stage a portable Node.js runtime:
   ```powershell
   mkdir agent-installer\staging\node-runtime
   copy "<path to your node.exe>" agent-installer\staging\node-runtime\node.exe
   ```
   Any recent Node 18+ Windows x64 `node.exe` works - `serialport`'s native
   binding is prebuilt via N-API, so it isn't tied to a specific Node version.
3. Make sure `agent/node_modules` is installed (`cd agent && npm install`) -
   the installer bundles it as-is, so whatever's there ships to end users.

## Build

```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" agent-installer\StemHardwareAgent.iss
```

Output: `agent-installer\Output\StemHardwareAgent-Setup-<version>.exe`

## What it installs

Per-user (no admin rights needed) to `%LOCALAPPDATA%\StemEducatorApp Hardware Agent\`:
- `node-runtime\node.exe` - the bundled runtime
- `src\`, `tools\` (arduino-cli), `firmware\` (stage_firmware), `node_modules\` - from `agent/`
- `run-agent.bat` - what the Start Menu / Desktop shortcut launches

Includes a standard uninstaller.
