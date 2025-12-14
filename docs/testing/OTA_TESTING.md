# OTA Update System Testing Strategy

This document outlines the testing strategy for the Over-The-Air (OTA) update system in The Small POS.

## 1. Manual Testing

Manual testing is crucial for the update experience involves system restarts and UI interactions that are difficult to fully automate.

### 1.1 Test Scenarios
| ID | Scenario | Steps | Expected Result |
|----|----------|-------|-----------------|
| OTA-001 | Update Available Notification | 1. Trigger `update-available` event (mock or real). | Notification modal appears with version info. |
| OTA-002 | Download Progress | 1. Click "Download Now". | Progress modal appears, bar fills up. |
| OTA-003 | Background Download | 1. Click "Remind Me Later". | Modal closes, update continues in background (if configured) or cancels. |
| OTA-004 | Install Now | 1. Wait for `update-downloaded`. <br>2. Click "Restart & Install". | App closes, installer runs (on Win), app reopens with new version. |
| OTA-005 | Install on Quit | 1. Wait for `update-downloaded`. <br>2. Close app manually. | Update installs silently. |
| OTA-006 | No Update Available | 1. Click "Check for Updates" in settings. | "You are up to date" toast/message appears. |
| OTA-007 | Error Handling | 1. Disconnect network during download. | "Update Failed" message appears with retry option. |

### 1.2 Setup for Manual Testing
To avoid publishing real releases for every test:
1.  **Dev Mode Mocking:** Use the `checkForUpdates` mock in `useAutoUpdater` (if implemented) or manually dispatch IPC events from the main process console.
    ```typescript
    // In Main Process Console
    mainWindow.webContents.send('auto-updater:update-available', { version: '1.2.0', releaseNotes: 'Fixes...' });
    ```
2.  **Local Server:** Use a local HTTP server to host `latest.yml` and artifacts. Point `electron-builder` config to `generic` provider with local URL.

## 2. Automated Unit Testing

Unit tests focus on the `AutoUpdaterService` logic and its interaction with `electron-updater` and `ipcMain`.

### 2.1 Key Test Cases (`tests/unit/services/AutoUpdaterService.spec.ts`)
- **Initialization:** Verify event listeners are attached to `autoUpdater`.
- **Channel Switching:** Verify `setChannel` updates `autoUpdater.channel` and `allowPrerelease`.
- **Check for Updates:** Verify `autoUpdater.checkForUpdates()` is called and returns result.
- **Events:** Verify service emits correct class-events when `electron-updater` events fire.
- **Error Handling:** Verify errors are caught and logged.

## 3. Integration Testing

Integration tests verify the IPC bridge between Renderer and Main.

- **Mocking:** Mock `electron-updater` in the main process.
- **Flow:**
    1. Renderer calls `ipcRenderer.invoke('update:check')`.
    2. Main process receives call, triggers service.
    3. Service mocks "Update Available".
    4. Renderer receives `update-available` event.
    5. Verify hook state updates to `available`.

## 4. Rollback Plan

If a bad update is deployed:

1.  **Stop the Bleeding:** Immediately revert the "Latest" release on GitHub to "Draft" or delete it.
2.  **Publish Fix:**
    - Revert code changes in `git`.
    - Bump version (e.g., `1.0.1` -> `1.0.2`).
    - Push tag to trigger new release.
3.  **Communication:** Notify users via other channels if necessary (though the app usually recovers by downloading the *next* update).
4.  **Database Rollback:** If the bad update included destructive DB migrations, manual intervention scripts might be needed (distributed via a "fixer" update). This emphasizes *additive-only* migrations.

## 5. Deployment Checklist
- [ ] Version bumped in `package.json`.
- [ ] `CHANGELOG.md` updated.
- [ ] `git tag` pushed.
- [ ] GitHub Action "Build" passed.
- [ ] Artifacts signed (check green checkmark on GitHub Release).
- [ ] Release notes verified on GitHub.
- [ ] Release published.
