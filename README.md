# The Small POS (Tauri Desktop)

Tauri desktop source for **The Small POS**.

This folder is the desktop release source of truth and is synced to the public repo:
- Public distribution repo: `EpsylonBita/The-Small-POS`
- Runtime: Tauri v2 + Rust backend + React UI
- Release platform: Windows x64 (NSIS)
- Updater manifest: `latest.json`

## 1) Scope

This app replaces Electron distribution for desktop updates/releases.

Primary goals:
- Keep POS behavior and renderer parity.
- Use Rust backend for local DB, sync, auth, print, diagnostics.
- Deliver signed updater flow with deterministic release assets.
- Keep the same visual app identity (icon/branding) as legacy desktop app.

## 2) Project Layout

- `src-tauri/` Tauri + Rust backend, icons, capabilities, config
- `src/` React + TypeScript renderer and compatibility adapters
- `scripts/` helper scripts (manifest generation, parity checks)
- `src-tauri/tauri.conf.json` bundle/updater config

## 3) Prerequisites

- Node.js 20+
- npm
- Rust stable toolchain
- Windows target: `x86_64-pc-windows-msvc`
- Windows build tools for native Rust dependencies

## 4) Local Commands

Install:

```bash
npm ci
```

Run dev app:

```bash
npm run pos:tauri:dev
```

Type-check and build frontend:

```bash
npm run type-check
npm run build
```

Build Windows NSIS installer:

```bash
npm run pos:tauri:bundle:win
```

## 5) Versioning Rules

Version must match in all three files:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Release workflow fails on mismatch.

## 6) Installer Branding and UX

Windows installer is configured for a modern branded setup:
- NSIS installer
- LZMA compression
- Start Menu folder `The Small POS`
- Per-machine install mode for managed terminal environments
- Installer icon: `src-tauri/icons/icon.ico`

Icon identity parity with legacy desktop is enforced in CI.

## 7) Auto-Update Contract

Updater endpoint configured in Tauri app:

```text
https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json
```

Each release publishes:
- `*.exe` installer
- matching `*.exe.sig`
- `latest.json`

`latest.json` includes:
- `version`
- `notes`
- `pub_date`
- `platforms.windows-x86_64.url`
- `platforms.windows-x86_64.signature`

## 8) Release Workflow

Workflow: `.github/workflows/pos-tauri-auto-release.yml`

High-level flow:
1. Validate version sync.
2. Inject updater pubkey.
3. Build NSIS bundle.
4. Sign installer.
5. Generate `latest.json`.
6. Sync `pos-tauri/` source to public repo root.
7. Recreate public release tag and upload assets.

Required repository secrets are documented in `RELEASE.md`.

## 9) Required Secrets

- `POS_RELEASE_TOKEN`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (if key is password protected)
- `TAURI_UPDATER_PUBKEY`

## 10) Admin Download Integration

Admin dashboard uses latest release from `EpsylonBita/The-Small-POS`.
Fallback env precedence:
1. `NEXT_PUBLIC_POS_TAURI_WINDOWS_DOWNLOAD_URL`
2. `NEXT_PUBLIC_POS_WINDOWS_DOWNLOAD_URL`

## 11) Troubleshooting

### `update endpoint did not respond with a successful status code`
Check:
- `latest.json` exists on latest public release URL.
- Latest release includes `.exe`, `.sig`, and `latest.json`.
- `tauri.conf.json` updater endpoint points to public repo.

### Update download fails after check succeeds
Check:
- `latest.json` asset URL matches the real release asset filename.
- `.sig` matches installer of same version.
- updater public key matches signing key pair.

### Signing step fails in CI
Check:
- `TAURI_SIGNING_PRIVATE_KEY` matches `TAURI_UPDATER_PUBKEY` pair.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is correct.

## 12) Additional Documentation

- `RELEASE.md`
- `ARCHITECTURE.md`
- `SUPPORT.md`
- `PARITY_CHECKLIST.md`
- `PARITY_GATES.md`

