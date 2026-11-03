import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync('scripts/check-release-runtime-config.mjs', 'utf8');
const start = script.indexOf('// This guard also runs');
const end = script.indexOf('const callerIdPinsPath');
const guard = new Function('fs', 'path', 'repositoryRoot', 'console', 'process', script.slice(start, end));
// Mirrors lib.rs (8.29): the environment and every configured window are
// stripped in release builds before the WebView is constructed.
const helper = `fn strip_release_webview_debugging_port() {
  #[cfg(not(debug_assertions))]
  strip_webview_environment_for_profile(true);
}
fn strip_webview_environment_for_profile(release: bool) {
  const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
  for flag in ["--remote-debugging-port", "--remote-debugging-pipe", "--auto-open-devtools-for-tabs"] { let _ = (release, flag); }
  std::env::set_var(KEY, "");
}
fn strip_webview_windows() {}
fn strip_release_webview_config(context: &mut Context) {
  if !cfg!(debug_assertions) { for window in context.windows() { window.additional_browser_args = None; } }
}`;
const valid = `${helper}\npub fn run() { strip_release_webview_debugging_port(); strip_release_webview_config(&mut context); tauri::Builder::default(); }`;
function validate(nativeSource: string, sources: Record<string, string> = {}) {
  const fs = {
    readFileSync: (file: string) => sources[path.basename(file)] ?? nativeSource,
    readdirSync: () => Object.keys(sources),
  };
  guard(fs, path, '.', { error: vi.fn() }, {
    exit: () => { throw new Error('Guard missing'); },
  });
}
describe('release WebView startup contract', () => {
  it('rejects startup with no debugging-port guard', () => {
    expect(() => validate('pub fn run() { tauri::Builder::default(); }')).toThrow('Guard missing');
  });
  it('rejects an unused guard or a call after WebView construction', () => {
    expect(() => validate(`${helper}\npub fn run() { strip_release_webview_config(&mut context); tauri::Builder::default(); }`)).toThrow('Guard missing');
    expect(() => validate(`${helper}\npub fn run() { strip_release_webview_config(&mut context); tauri::Builder::default(); strip_release_webview_debugging_port(); }`)).toThrow('Guard missing');
  });
  it('requires the release condition, every debugging flag, the window strip and the environment update', () => {
    expect(() => validate(valid)).not.toThrow();
    expect(() => validate(valid.replaceAll('#[cfg(not(debug_assertions))]', ''))).toThrow('Guard missing');
    expect(() => validate(valid.replace('!cfg!(debug_assertions)', 'true'))).toThrow('Guard missing');
    expect(() => validate(valid.replace('std::env::set_var', 'update_other_variable'))).toThrow('Guard missing');
    expect(() => validate(valid.replace('strip_release_webview_config(&mut context); tauri', 'tauri'))).toThrow('Guard missing');
    for (const flag of ['--remote-debugging-port', '--remote-debugging-pipe', '--auto-open-devtools-for-tabs']) {
      expect(() => validate(valid.replace(flag, '--other'))).toThrow('Guard missing');
    }
  });
  it('rejects a code-created WebView with its own browser arguments', () => {
    expect(() => validate(valid, { 'main.rs': valid, 'lib.rs': valid, 'window.rs': 'builder.additional_browser_args("--x")' })).toThrow('Guard missing');
  });
  it('runs before the private-workflow absence can skip the rest of the release check', () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(script.indexOf('if (!fs.existsSync(workflowPath))'));
  });
});
