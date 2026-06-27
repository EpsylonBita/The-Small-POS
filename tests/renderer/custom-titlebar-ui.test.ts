import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const framePath = path.join(projectRoot, 'src', 'renderer', 'components', 'AppWindowFrame.tsx');
const fullscreenLayoutPath = path.join(projectRoot, 'src', 'renderer', 'components', 'FullscreenAwareLayout.tsx');
const mainLayoutPath = path.join(projectRoot, 'src', 'renderer', 'components', 'RefactoredMainLayout.tsx');
const appPath = path.join(projectRoot, 'src', 'renderer', 'App.tsx');
const windowStateHookPath = path.join(projectRoot, 'src', 'renderer', 'hooks', 'useWindowState.ts');
const systemUiPath = path.join(projectRoot, 'src-tauri', 'src', 'commands', 'system_ui.rs');
const tauriLibPath = path.join(projectRoot, 'src-tauri', 'src', 'lib.rs');
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json');
const tauriCapabilityPath = path.join(projectRoot, 'src-tauri', 'capabilities', 'default.json');

test('frameless Tauri window is backed by the slim app frame, not the removed desktop menu bar', () => {
  const layoutSource = readFileSync(fullscreenLayoutPath, 'utf8');
  const configSource = readFileSync(tauriConfigPath, 'utf8');
  const capabilitySource = readFileSync(tauriCapabilityPath, 'utf8');

  assert.match(configSource, /"decorations": false/);
  assert.match(capabilitySource, /"core:window:allow-start-dragging"/);
  assert.match(layoutSource, /import AppWindowFrame/);
  assert.match(layoutSource, /relative flex h-screen min-h-0 flex-col overflow-hidden/);
  assert.match(layoutSource, /flex min-h-0 flex-1 flex-col overflow-hidden/);
  assert.doesNotMatch(layoutSource, /className="fixed inset-x-0 top-0"/);
  assert.doesNotMatch(layoutSource, /CustomTitleBar/);
  assert.doesNotMatch(layoutSource, /File\/Edit\/View\/Window\/Help dropdown row/);
  assert.doesNotMatch(layoutSource, /pt-8/);
});

test('AppWindowFrame keeps update access visible and uses touch-safe window controls', () => {
  const source = readFileSync(framePath, 'utf8');
  const nativeDragSource = source.match(
    /const startNativeWindowDrag = useCallback\([\s\S]*?const scheduleWindowMove = useCallback/,
  );
  const pointerDragSource = source.match(
    /const startWindowDrag = useCallback\([\s\S]*?const startWindowMouseDrag = useCallback/,
  );
  const mouseDragSource = source.match(
    /const startWindowMouseDrag = useCallback\([\s\S]*?const moveWindowDrag = useCallback/,
  );

  assert.match(source, /data-app-window-frame/);
  assert.match(source, /import \{ getCurrentWindow \} from '@tauri-apps\/api\/window'/);
  assert.match(source, /const startWindowDrag = useCallback/);
  assert.match(source, /const startWindowMouseDrag = useCallback/);
  assert.match(source, /const startNativeWindowDrag = useCallback/);
  assert.match(source, /const moveWindowDrag = useCallback/);
  assert.match(source, /const stopWindowDrag = useCallback/);
  assert.match(source, /onPointerDown=\{startWindowDrag\}/);
  assert.match(source, /onMouseDown=\{startWindowMouseDrag\}/);
  assert.match(source, /onPointerMove=\{moveWindowDrag\}/);
  assert.match(source, /onPointerUp=\{stopWindowDrag\}/);
  assert.match(source, /dragListenerCleanupRef/);
  assert.match(source, /cleanupWindowDragListeners/);
  assert.match(source, /window\.addEventListener\('pointermove', handleGlobalMove, true\)/);
  assert.match(source, /window\.addEventListener\('pointerup', handleGlobalStop, true\)/);
  assert.match(source, /window\.addEventListener\('pointercancel', handleGlobalStop, true\)/);
  assert.match(source, /window\.removeEventListener\('pointermove', handleGlobalMove, true\)/);
  assert.match(source, /data-app-window-drag-zone/);
  assert.match(source, /style=\{\{ zIndex: 2147483600, pointerEvents: 'auto' \}\}/);
  assert.match(source, /className=\{`fixed inset-x-0 top-0 h-16 shrink-0 touch-none select-none bg-transparent px-2 \$\{className\}`\}/);
  assert.doesNotMatch(source, /className=\{`relative h-10/);
  assert.match(source, /absolute inset-x-0 inset-y-0/);
  assert.match(source, /touch-none cursor-grab bg-transparent active:cursor-grabbing/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /data-tauri-drag-region/);
  assert.doesNotMatch(source, /dragRegionStyle/);
  assert.doesNotMatch(source, /WebkitAppRegion/);
  assert.doesNotMatch(source, /target\?\.closest\('\[data-tauri-drag-region\]'\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.ok(nativeDragSource, 'startNativeWindowDrag source should be present');
  assert.ok(pointerDragSource, 'startWindowDrag source should be present');
  assert.ok(mouseDragSource, 'startWindowMouseDrag source should be present');
  assert.match(nativeDragSource[0], /void appWindow\.startDragging\(\)\.catch/);
  assert.match(nativeDragSource[0], /if \(windowState\?\.isFullScreen\) \{\s*return;\s*\}/);
  assert.match(pointerDragSource[0], /if \(windowState\?\.isFullScreen\) \{\s*return;\s*\}/);
  assert.match(pointerDragSource[0], /event\.preventDefault\(\);\s*cleanupWindowDragListeners\(\);/);
  assert.match(pointerDragSource[0], /startNativeWindowDrag\(\);/);
  assert.doesNotMatch(pointerDragSource[0], /startNativeWindowDrag\(\);\s*if \(event\.pointerType !== 'mouse'\)/);
  assert.match(mouseDragSource[0], /if \(dragSessionRef\.current\) \{\s*return;\s*\}/);
  assert.match(source, /if \(windowState\?\.isMaximized\) \{\s*await bridge\.window\.maximize\(\)\.catch/);
  assert.doesNotMatch(nativeDragSource[0], /await appWindow\.isMaximized\(\)/);
  assert.doesNotMatch(nativeDragSource[0], /await appWindow\.toggleMaximize\(\)/);
  assert.match(source, /void bridge\.window\.startDrag\(\)\.catch/);
  assert.match(source, /void prepareManualDrag\(\)\.then/);
  assert.match(source, /bridge\.window\.setPosition\(\{ x, y \}\)/);
  assert.match(source, /native window\.startDragging failed/);
  assert.match(source, /window\.startDrag failed/);
  assert.match(source, /window\.getPosition failed/);
  assert.match(source, /window\.setPosition failed/);
  assert.doesNotMatch(source, /PhysicalPosition/);
  assert.match(source, /data-app-window-no-drag/);
  assert.match(source, /closest\('\[data-app-window-no-drag\], button, a, input, select, textarea'\)/);
  assert.match(source, /const stopWindowControlPointer = useCallback/);
  assert.match(source, /onPointerDown=\{stopWindowControlPointer\}/);
  assert.match(source, /onMouseDown=\{stopWindowControlMouse\}/);
  assert.match(source, /bg-transparent/);
  assert.match(source, /import logoDark from '\.\.\/assets\/logo-black\.png'/);
  assert.match(source, /import logoLight from '\.\.\/assets\/logo-white\.png'/);
  assert.match(source, /const logoSource = isDark \? logoDark : logoLight/);
  assert.match(source, /src=\{logoSource\}/);
  assert.doesNotMatch(source, />\s*S\s*</);
  assert.doesNotMatch(source, />\s*The Small POS\s*</);
  assert.match(source, /data-app-frame-update/);
  assert.match(source, /data-update-status=\{update\.status\}/);
  assert.match(source, /statusIcon/);
  assert.match(source, /updateTone\(update\.status, isDark\)/);
  assert.match(source, /absolute left-1\/2 top-1\/2/);
  assert.match(source, /-translate-x-1\/2 -translate-y-1\/2/);

  for (const control of ['minimize', 'fullscreen', 'close']) {
    assert.match(source, new RegExp(`data-app-window-control="${control}"`));
  }
  assert.doesNotMatch(source, /data-app-window-control="maximize"/);

  assert.match(source, /runWindowCommand\('minimize'\)/);
  assert.match(source, /runWindowCommand\('maximize'\)/);
  assert.doesNotMatch(source, /runWindowCommand\('toggleFullscreen'\)/);
  assert.match(source, /runWindowCommand\('close'\)/);
  assert.match(source, /const appWindow = getCurrentWindow\(\)/);
  assert.match(source, /await appWindow\.minimize\(\)/);
  assert.match(source, /await appWindow\.toggleMaximize\(\)/);
  assert.doesNotMatch(source, /appWindow\.isFullscreen\(\)/);
  assert.doesNotMatch(source, /appWindow\.setFullscreen/);
  assert.match(source, /await appWindow\.close\(\)/);
  assert.match(source, /native window\.\$\{command\} failed/);
  assert.match(source, /bridge\.window\[command\]\(\)/);
  assert.match(
    source,
    /data-app-window-control="fullscreen"[\s\S]*?onClick=\{\(\) => runWindowCommand\('maximize'\)\}/,
  );
  assert.doesNotMatch(source, /active:scale-90/);
  assert.match(source, /inline-flex h-\[60px\] min-h-\[60px\] w-\[64px\] min-w-\[64px\] shrink-0 touch-manipulation items-center justify-center bg-transparent p-0 leading-none/);
  assert.match(source, /className="absolute right-0 top-0 z-30 flex h-16 items-start gap-0"/);
  assert.match(source, /<Minus className="block h-5 w-5 translate-y-\[2px\]" \/>/);
  assert.doesNotMatch(source, /\bSquare\b/);
  assert.match(source, /<X className="block h-5 w-5" \/>/);
  const controlBase = source.match(/const controlBase = `([\s\S]*?)`;/);
  assert.ok(controlBase, 'window control base classes should be centralized');
  assert.doesNotMatch(controlBase[1], /border/);
  assert.doesNotMatch(controlBase[1], /rounded/);
  assert.doesNotMatch(source, /Maximize2|Minimize2/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\stitle=/);
});

test('window state hook listens to the native event name emitted by Rust', () => {
  const hookSource = readFileSync(windowStateHookPath, 'utf8');
  const rustSource = readFileSync(systemUiPath, 'utf8');

  assert.match(rustSource, /window\.emit\("window_state_changed"/);
  assert.match(hookSource, /onEvent\('window_state_changed', handleWindowStateChanged\)/);
  assert.match(hookSource, /offEvent\('window_state_changed', handleWindowStateChanged\)/);
  assert.doesNotMatch(hookSource, /window-state-changed/);
});

test('App wires updater state into the frame on login and main POS routes', () => {
  const source = readFileSync(appPath, 'utf8');

  assert.match(source, /function getFrameUpdateStatus/);
  assert.match(source, /function getFrameUpdateLabel/);
  assert.match(source, /function getFrameUpdateDetail/);
  assert.match(source, /const frameUpdate = useMemo<AppFrameUpdate \| undefined>/);
  assert.match(source, /if \(status === 'not-available' \|\| status === 'checking'\) \{/);
  assert.match(source, /const hasActionableUpdate =/);
  assert.match(source, /if \(!hasActionableUpdate\) \{/);
  assert.match(source, /onOpen: autoUpdater\.openUpdateDialog/);
  assert.match(source, /autoUpdater\.currentVersion\.toLowerCase\(\) !== 'unknown'/);
  assert.match(source, /const openUpdateCheck = useCallback/);
  assert.match(source, /event\.key\.toLowerCase\(\) === 'u'/);
  assert.match(source, /const updateDialog = \(/);

  const framedLayoutCount = (source.match(/<FullscreenAwareLayout update=\{frameUpdate\} windowState=\{windowState\}>/g) || []).length;
  assert.equal(framedLayoutCount, 2, 'login and main POS shell should both expose the update frame');
  assert.match(source, /<PageLoadMotion animationKey="login" className="h-full min-h-0">/);
  assert.match(source, /<LoginPage onLogin=\{handleLogin\} \/>/);
  assert.doesNotMatch(source, /<LoginPage onLogin=\{handleLogin\} onOpenSettings=/);
  assert.match(source, /onCheckForUpdates=\{openUpdateCheck\}/);
  assert.match(source, /<PageLoadMotion animationKey="new-order" className="h-full min-h-0">/);
  assert.match(source, /if \(!user\) \{\s*setShowConnectionSettings\(false\);/);
  assert.match(source, /className="fixed top-12 left-\[9\.5rem\] z-40"/);
  assert.match(source, /<SyncStatusIndicator onOpenRecovery=\{openSyncRecovery\} \/>/);
  const unauthenticatedBranch = source.slice(
    source.indexOf('// Show login when no user'),
    source.indexOf('// Show main POS interface if logged in'),
  );
  assert.ok(unauthenticatedBranch, 'unauthenticated branch should be present');
  assert.doesNotMatch(unauthenticatedBranch, /ConnectionSettingsModal/);
  assert.doesNotMatch(unauthenticatedBranch, /showConnectionSettings/);
  assert.match(source, /\{updateDialog\}\s*<\/FullscreenAwareLayout>/);
});

test('app shell loading and shift blockers use palette-safe tap feedback', () => {
  const appSource = readFileSync(appPath, 'utf8');
  const layoutSource = readFileSync(mainLayoutPath, 'utf8');

  assert.doesNotMatch(appSource, /border-blue-500/);
  assert.match(appSource, /border-amber-400 rounded-full animate-spin/);

  assert.doesNotMatch(layoutSource, /border-blue-600/);
  assert.doesNotMatch(layoutSource, /hover:bg-/);
  assert.match(layoutSource, /border-b-2 border-amber-400/);
  assert.match(layoutSource, /active:bg-amber-400/);
  assert.match(layoutSource, /active:bg-gray-600/);
  assert.match(layoutSource, /active:bg-gray-200/);
  assert.match(layoutSource, /active:bg-red-700/);
});

test('RefactoredMainLayout fills the frame remainder and still routes settings to the modal', () => {
  const source = readFileSync(mainLayoutPath, 'utf8');

  assert.match(source, /relative flex h-full min-h-0 transition-all duration-300 overflow-hidden/);
  assert.doesNotMatch(source, /h-screen h-\[100dvh\]/);
  assert.doesNotMatch(source, /SettingsPage/);
  assert.doesNotMatch(source, /settings: \(\) => <SettingsPage \/>/);
  assert.match(
    source,
    /if \(view === 'settings'\) \{\s*onOpenConnectionSettings\?\.\(null\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(currentView !== 'settings'\) \{\s*return;\s*\}\s*setCurrentView\('dashboard'\);\s*onOpenConnectionSettings\?\.\(null\);/,
  );
  assert.match(
    source,
    /if \(pendingView === 'settings'\) \{\s*onOpenConnectionSettings\?\.\(null\);/,
  );
  assert.match(source, /if \(currentView === 'settings'\) \{\s*return <DashboardView \/>;\s*\}/);
});

test('Tauri window menu commands call native webview APIs instead of no-op stubs', () => {
  const source = readFileSync(systemUiPath, 'utf8');
  const tauriLibSource = readFileSync(tauriLibPath, 'utf8');

  assert.match(source, /pub async fn window_start_drag\(window: tauri::Window\)/);
  assert.match(source, /window\.start_dragging\(\)/);
  assert.match(source, /pub async fn window_get_position\(window: tauri::Window\)/);
  assert.match(source, /window\.outer_position\(\)/);
  assert.match(source, /pub async fn window_set_position/);
  assert.match(source, /window\s*\.set_position\(tauri::Position::Physical/);
  assert.match(tauriLibSource, /commands::system_ui::window_start_drag/);
  assert.match(tauriLibSource, /commands::system_ui::window_get_position/);
  assert.match(tauriLibSource, /commands::system_ui::window_set_position/);
  assert.match(source, /fn current_webview_window\(window: &tauri::Window\)/);
  assert.match(source, /current_webview_window\(&window\)\?\s*\.reload\(\)/);
  assert.match(source, /current_webview_window\(&window\)\?\s*\.eval\("window\.location\.reload\(\);"\)/);
  assert.match(source, /webview\.open_devtools\(\)/);
  assert.match(source, /webview\.close_devtools\(\)/);
  assert.match(source, /webview\.set_zoom\(clamped\)/);
  assert.match(source, /WINDOW_ZOOM_STEP/);
});
