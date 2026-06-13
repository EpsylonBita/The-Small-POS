import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const titleBarPath = path.join(projectRoot, 'src', 'renderer', 'components', 'CustomTitleBar.tsx');
const fullscreenLayoutPath = path.join(projectRoot, 'src', 'renderer', 'components', 'FullscreenAwareLayout.tsx');
const mainLayoutPath = path.join(projectRoot, 'src', 'renderer', 'components', 'RefactoredMainLayout.tsx');
const appPath = path.join(projectRoot, 'src', 'renderer', 'App.tsx');
const systemUiPath = path.join(projectRoot, 'src-tauri', 'src', 'commands', 'system_ui.rs');
const rustLibPath = path.join(projectRoot, 'src-tauri', 'src', 'lib.rs');

test('CustomTitleBar app menus stay above POS content and navigation chrome', () => {
  const source = readFileSync(titleBarPath, 'utf8');

  assert.match(
    source,
    /fixed top-0 left-0 right-0 z-\[2147483646\]/,
    'title bar should create a top-level stacking layer above app content',
  );
  assert.match(
    source,
    /absolute top-full left-0 mt-0 min-w-\[200px\] py-1 shadow-lg rounded-md z-\[2147483647\]/,
    'opened app menu should render above the title bar and POS shell',
  );
  assert.match(
    source,
    /<div className="fixed inset-0 z-\[2147483647\] flex items-center justify-center">/,
    'reset dialog should stay above the raised title bar layer',
  );
  assert.doesNotMatch(source, /fixed top-0 left-0 right-0 z-30/);
  assert.doesNotMatch(source, /shadow-lg rounded-md z-50/);
});

test('CustomTitleBar settings menu item opens the connection settings modal callback', () => {
  const source = readFileSync(titleBarPath, 'utf8');
  const fullscreenLayoutSource = readFileSync(fullscreenLayoutPath, 'utf8');
  const appSource = readFileSync(appPath, 'utf8');

  assert.match(source, /onOpenSettings\?: \(\) => void/);
  assert.match(source, /label: 'Settings'/);
  assert.match(
    source,
    /action: async \(\) => \{\s*onOpenSettings\?\.\(\);\s*\}/,
  );
  assert.match(fullscreenLayoutSource, /onOpenSettings\?: \(\) => void/);
  assert.match(fullscreenLayoutSource, /onOpenSettings=\{onOpenSettings\}/);
  assert.match(appSource, /onOpenSettings=\{\(\) => openConnectionSettings\(\)\}/);
  assert.doesNotMatch(source, /view: 'settings'/);
  assert.doesNotMatch(source, /console\.log\('Open settings'\)/);
});

test('RefactoredMainLayout maps settings navigation to the modal instead of the removed page', () => {
  const source = readFileSync(mainLayoutPath, 'utf8');

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

test('CustomTitleBar Help menu opens allowlisted external support links', () => {
  const source = readFileSync(titleBarPath, 'utf8');
  const rustLibSource = readFileSync(rustLibPath, 'utf8');

  assert.match(source, /import \{ openExternalUrl \} from '\.\.\/utils\/external-url'/);
  assert.match(source, /HELP_LINKS[\s\S]*https:\/\/github\.com\/EpsylonBita\/The-Small-POS\/tree\/main\/docs/);
  assert.match(source, /HELP_LINKS[\s\S]*https:\/\/github\.com\/EpsylonBita\/The-Small-POS\/discussions/);
  assert.match(source, /HELP_LINKS[\s\S]*https:\/\/github\.com\/EpsylonBita\/The-Small-POS\/issues\/new\/choose/);
  assert.match(source, /await openHelpLink\(HELP_LINKS\.documentation\)/);
  assert.match(source, /await openHelpLink\(HELP_LINKS\.community\)/);
  assert.match(source, /await openHelpLink\(HELP_LINKS\.issue\)/);
  assert.match(rustLibSource, /"github\.com"/);
  assert.doesNotMatch(source, /console\.log\('Open documentation'\)/);
  assert.doesNotMatch(source, /console\.log\('Open community'\)/);
  assert.doesNotMatch(source, /console\.log\('Report issue'\)/);
});

test('CustomTitleBar edit menu uses app edit commands and shortcut handlers instead of execCommand', () => {
  const source = readFileSync(titleBarPath, 'utf8');

  assert.match(source, /new CustomEvent\('pos:edit-command'/);
  assert.match(source, /window\.addEventListener\('keydown', handleEditShortcut, true\)/);
  assert.match(source, /await bridge\.clipboard\.writeText\(selectedText\)/);
  assert.match(source, /await bridge\.clipboard\.readText\(\)/);
  assert.match(source, /setRangeText\(replacement, start, end, 'end'\)/);
  assert.doesNotMatch(source, /document\.execCommand/);
});

test('Tauri window menu commands call native webview APIs instead of no-op stubs', () => {
  const source = readFileSync(systemUiPath, 'utf8');

  assert.match(source, /fn current_webview_window\(window: &tauri::Window\)/);
  assert.match(source, /current_webview_window\(&window\)\?\s*\.reload\(\)/);
  assert.match(source, /current_webview_window\(&window\)\?\s*\.eval\("window\.location\.reload\(\);"\)/);
  assert.match(source, /webview\.open_devtools\(\)/);
  assert.match(source, /webview\.close_devtools\(\)/);
  assert.match(source, /webview\.set_zoom\(clamped\)/);
  assert.match(source, /WINDOW_ZOOM_STEP/);
});
