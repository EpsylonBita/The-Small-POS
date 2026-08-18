// @vitest-environment node
// (importing vite.config.ts loads esbuild, whose TextEncoder invariant check
// rejects the jsdom environment — this suite needs no DOM anyway)
/**
 * Pins the console-retention policy of the vite build config:
 *
 *  - Production (release `tauri build`, where TAURI_ENV_DEBUG is UNSET —
 *    probed empirically 2026-08-18): console.log/debug/info are marked pure
 *    (stripped by the esbuild minify pass), console.warn/console.error are
 *    NOT — genuine failures must reach WebView2's retained console buffer.
 *  - Dev (`vite serve`): no console level is stripped at all.
 *  - Debug builds (TAURI_ENV_DEBUG="true"): nothing stripped, no minify.
 *
 * Regression pins: `drop: ['console']` (the old config) also killed
 * warn/error in the shipped bundle, and a truthiness check on
 * TAURI_ENV_DEBUG would misread a future string "false" as debug mode.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import viteConfigExport from '../../../../vite.config';

const resolveConfig = (command: ConfigEnv['command']): UserConfig =>
  (viteConfigExport as unknown as (env: ConfigEnv) => UserConfig)({
    command,
    mode: command === 'serve' ? 'development' : 'production',
    isPreview: false,
    isSsrBuild: false,
  });

describe('vite config console stripping', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('release build (TAURI_ENV_DEBUG unset, the real tauri build env): strips log/debug/info, keeps warn/error', () => {
    vi.stubEnv('TAURI_ENV_DEBUG', undefined);
    const config = resolveConfig('build');
    const pure = config.esbuild && config.esbuild.pure;
    const drop = config.esbuild && config.esbuild.drop;

    expect(pure).toEqual(
      expect.arrayContaining(['console.log', 'console.debug', 'console.info']),
    );
    expect(pure).not.toContain('console.warn');
    expect(pure).not.toContain('console.error');
    // 'console' in drop would strip warn/error too — that was the old defect.
    expect(drop).toEqual(['debugger']);
    // pure annotations are only acted on by the minify pass.
    expect(config.build?.minify).toBe('esbuild');
  });

  it('release build with a literal string "false" behaves as release, not debug', () => {
    vi.stubEnv('TAURI_ENV_DEBUG', 'false');
    const config = resolveConfig('build');
    expect(config.esbuild && config.esbuild.pure).toContain('console.log');
    expect(config.build?.minify).toBe('esbuild');
    expect(config.build?.sourcemap).toBe(false);
  });

  it('dev serve: no console level is stripped — warn/error (and log) behave normally', () => {
    vi.stubEnv('TAURI_ENV_DEBUG', undefined);
    const config = resolveConfig('serve');
    expect(config.esbuild).toEqual({});
  });

  it('debug build (TAURI_ENV_DEBUG="true"): nothing stripped, unminified, sourcemapped', () => {
    vi.stubEnv('TAURI_ENV_DEBUG', 'true');
    const config = resolveConfig('build');
    expect(config.esbuild).toEqual({});
    expect(config.build?.minify).toBe(false);
    expect(config.build?.sourcemap).toBe(true);
  });
});
