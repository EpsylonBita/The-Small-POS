# The Small POS (Tauri Desktop)

Public desktop distribution repository for **The Small POS**.

Desktop releases are now **Tauri + Rust** (Electron distribution has been retired for release/update delivery).

## 1) What This Repository Is

This repo hosts the public desktop source and release artifacts used by POS terminals:
- Runtime: **Tauri v2**
- Backend: **Rust**
- UI: **React/TypeScript**
- Platform: **Windows x64**
- Installer: **NSIS `.exe`**
- Updater feed: **`latest.json`** (Tauri updater manifest)

Latest public release page:
- <https://github.com/EpsylonBita/The-Small-POS/releases/latest>

Updater endpoint used by the app:
- <https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json>

## 2) Cutover Status

The desktop distribution cutover is complete:
- Release/update source of truth moved from Electron to Tauri.
- Public releases now target Tauri artifact contract.
- Admin dashboard downloads target this repo's latest Windows installer.

## 3) Key Desktop Capabilities

- Native Rust backend for local DB, auth, sync, print, and diagnostics.
- Reused POS renderer flow with Tauri IPC bridge compatibility.
- Signed update flow with `latest.json` + minisign signature verification.
- Branded Windows installer with the same app icon identity as Electron.

## 4) Repository Layout

Top-level folders and files:
- `src-tauri/` Rust backend, Tauri config, icons, capabilities
- `src/` React app and compatibility adapters
- `scripts/` release helper scripts (manifest generation, smoke checks)
- `RELEASE.md` release runbook
- `ARCHITECTURE.md` architecture overview
- `SUPPORT.md` troubleshooting/support notes

## 5) Prerequisites (Local Build)

- Node.js 20+
- npm
- Rust stable toolchain
- Windows target: `x86_64-pc-windows-msvc`
- Windows build tools (for native Rust dependencies)

## 6) Local Development

Install dependencies:

```bash
npm ci
```

Run dev mode:

```bash
npm run pos:tauri:dev
```

Type check + build:

```bash
npm run type-check
npm run build
```

## 7) Windows Installer Build (NSIS)

Build Windows NSIS bundle:

```bash
npm run pos:tauri:bundle:win
```

Installer output is generated under:

```text
src-tauri/target/release/bundle/nsis/
```

Expected installer artifact pattern:

```text
The Small POS_<version>_x64-setup.exe
```

## 8) Installer Branding and UX

The installer is intentionally configured as a modern branded setup:
- NSIS installer with LZMA compression.
- Start Menu folder: `The Small POS`.
- Per-machine install mode for managed terminal environments.
- Installer icon is forced to app icon: `src-tauri/icons/icon.ico`.

Icon identity policy:
- Tauri icon assets must match legacy Electron identity.
- CI verifies parity during release flow.

## 9) Auto-Update Contract (Tauri)

Each release tag `v<version>` publishes:
- `The Small POS_<version>_x64-setup.exe`
- `The Small POS_<version>_x64-setup.exe.sig`
- `latest.json`

`latest.json` contract:

```json
{
  "version": "1.2.0",
  "notes": "Release v1.2.0",
  "pub_date": "2026-02-19T12:00:00.000Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/EpsylonBita/The-Small-POS/releases/download/v1.2.0/The Small POS_1.2.0_x64-setup.exe",
      "signature": "<minisign signature>"
    }
  }
}
```

## 10) Production Release Pipeline

Production release automation runs from the main development repository (`The-Small-002`) and syncs this public repo.

High-level flow:
1. Validate version sync (`package.json`, `Cargo.toml`, `tauri.conf.json`).
2. Build NSIS installer for Windows x64.
3. Sign installer and generate `latest.json`.
4. Sync `pos-tauri` source into this repo root.
5. Recreate release `v<version>` and upload `.exe`, `.sig`, `latest.json`.

Required secrets are documented in:
- `RELEASE.md`

## 11) Admin Dashboard Download Behavior

Admin dashboard download flow targets latest release assets from this repo.

Windows fallback env precedence:
1. `NEXT_PUBLIC_POS_TAURI_WINDOWS_DOWNLOAD_URL` (preferred)
2. `NEXT_PUBLIC_POS_WINDOWS_DOWNLOAD_URL` (legacy compatibility)

## 12) Troubleshooting

### A) `update endpoint did not respond with a successful status code`

Check:
- `latest.json` exists on latest release URL.
- The latest release actually includes `latest.json`, `.exe`, and `.sig`.
- `src-tauri/tauri.conf.json` updater endpoint matches this repo URL.

### B) Update found but install fails

Check:
- `.sig` matches installer for that exact version.
- Updater public key in app config matches signer key used in release.
- Asset URL in `latest.json` resolves to downloadable installer.

### C) Installer branding incorrect

Check:
- `src-tauri/tauri.conf.json` NSIS config includes installer icon setting.
- `src-tauri/icons/icon.ico` is the intended production icon.

## 13) Migration Notes (Electron -> Tauri)

What changed operationally:
- Electron release automation is disabled for desktop distribution.
- Tauri release line starts at `1.2.0`.
- Public repo releases now follow Tauri updater artifact format.

## 14) Additional Docs

- Architecture: `ARCHITECTURE.md`
- Release operations: `RELEASE.md`
- Support runbook: `SUPPORT.md`
- Migration/parity references: `PARITY_CHECKLIST.md`, `PARITY_GATES.md`, `PHASE2_NOTES.md`, `PHASE4_NOTES.md`, `PHASE8_COMPLETE.md`, `PHASE8_SUMMARY.md`

---

If you are looking for the old Electron release path, use repository history only. Active desktop release/update operations are Tauri-based.
