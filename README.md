# The Small POS (Tauri Desktop)

This repository is the public desktop distribution source for **The Small POS**.

## Current Desktop Runtime
- Runtime: **Tauri v2 + Rust backend**
- Platform releases: **Windows x64**
- Installer: **NSIS setup (.exe)**
- Auto-update feed: `latest.json` (Tauri updater format)

## Download
- Latest release page: <https://github.com/EpsylonBita/The-Small-POS/releases/latest>
- Direct updater manifest: <https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json>

## Release Artifacts
Each release tag `v<version>` publishes:
- `The Small POS_<version>_x64-setup.exe`
- `The Small POS_<version>_x64-setup.exe.sig`
- `latest.json`

## Installer Branding
The installer is configured to keep The Small POS application identity:
- Uses the app icon (`src-tauri/icons/icon.ico`) in the Windows installer
- Uses modern NSIS packaging settings (LZMA compression, Start Menu folder)
- Per-machine install mode for managed POS terminals

## Source of Truth
The desktop cutover is complete: Electron release distribution has been replaced by Tauri.
This public repo is synced from the `pos-tauri` app source in the main development repository.

## Local Build (Windows)
```bash
npm ci
npm run pos:tauri:bundle:win
```

## Update Endpoint Contract (Tauri)
`latest.json` includes:
- `version`
- `notes`
- `pub_date`
- `platforms.windows-x86_64.url`
- `platforms.windows-x86_64.signature`

The app checks updates from:
`https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json`
