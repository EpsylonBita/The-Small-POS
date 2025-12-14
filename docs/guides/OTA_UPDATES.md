# OTA Updates & Release Guide

This guide details the Over-The-Air (OTA) update system for The Small POS, covering the user experience, developer process, and configuration.

## 1. Overview

The OTA update system enables seamless delivery of bug fixes and new features to POS instances without requiring manual re-installation. It uses [electron-builder](https://www.electron.build/) and [GitHub Releases](https://github.com/The-Small-POS/The-Small-002/releases) to distribute updates.

**Key Features:**
- **Automatic Background Checks:** Checks for updates every 4 hours.
- **Channels:** Support for `stable` (default) and `beta` channels.
- **Differential Updates:** Downloads only what changed (faster).
- **Silent Installation:** Installs updates on next restart or immediately if requested.

## 2. Architecture

For a detailed sequence diagram of the OTA update process (Check → Download → Install → Restart), please refer to the [OTA Update Flow in POS Architecture](../architecture/ARCHITECTURE.md#ota-update-flow).

## 3. User Experience

1.  **Notification:** When an update is found, an "Update Available" notification appears.
2.  **Download:** The user can click "Download Now" or "Remind Me Later".
3.  **Progress:** A progress modal shows download status (speed, percentage).
4.  **Installation:** Once downloaded, the user is prompted to "Restart & Install" or "Install on Next Restart".

## 4. Developer Guide

### Release Process

Deploying a new version is fully automated via GitHub Actions.

1.  **Bump Version:**
    Update `version` in `pos-system/package.json`.
    ```bash
    npm version patch --no-git-tag-version # or minor/major
    ```

2.  **Commit & Tag:**
    ```bash
    git commit -am "chore: release v1.0.1"
    git tag pos-v1.0.1
    git push origin pos-v1.0.1
    ```

3.  **Automation:**
    The GitHub Action `POS System Release` will trigger:
    - Build for Windows, macOS, and Linux.
    - Create a GitHub Release.
    - Upload artifacts (exe, dmg, AppImage).
    - Publish release.

### Manual Builds (Testing)

To build locally for testing:
```bash
cd pos-system
npm run dist
```
Artifacts will be in `pos-system/release/`.

## 5. Code Signing Setup

Code signing is required for auto-updates to work without warnings (especially on macOS) and is strictly enforced by auto-updater on Windows.

### Windows (DigiCert / Sectigo)
1.  Obtain a Code Signing Certificate (.pfx).
2.  Encode as Base64:
    ```powershell
    [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) > cert_b64.txt
    ```
3.  Add Secrets to GitHub Repo:
    - `WIN_CSC_LINK`: Content of `cert_b64.txt`
    - `WIN_CSC_KEY_PASSWORD`: PFX Password

### macOS (Apple Developer ID)
1.  Export Developer ID Application certificate as `.p12`.
2.  Encode as Base64:
    ```bash
    base64 -i cert.p12 -o cert_b64.txt
    ```
3.  Add Secrets to GitHub Repo:
    - `MAC_CSC_LINK`: Content of `cert_b64.txt`
    - `MAC_CSC_KEY_PASSWORD`: Certificate Password
    - `APPLE_ID`: Your Apple ID email
    - `APPLE_ID_PASSWORD`: App-Specific Password (not your main password)

## 6. Configuration Reference

Configuration can be tuned via environment variables or `electron-builder.yml` (if added).

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| Channel | `UPDATE_CHANNEL` | `stable` | `stable` or `beta` |
| Check Interval | N/A | 4 hours | Hardcoded in `AutoUpdaterService` |

## 7. Troubleshooting

**Update Verification Failed**
*Cause:* Code signing mismatch or corrupted download.
*Fix:* Ensure the certificate used to sign the new version matches the old version.

**"Update not found"**
*Cause:* GitHub API rate limit or draft release.
*Fix:* Ensure the release is "Published" (not Draft) on GitHub.

**Logs**
Logs are written to:
- Windows: `%APPDATA%\the-small-pos-system\logs\main.log`
- macOS: `~/Library/Logs/the-small-pos-system/main.log`
