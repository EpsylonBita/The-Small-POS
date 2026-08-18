import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
//
// Console policy (WebView2 retains the last ~1000 console messages WITH their
// argument object graphs even when DevTools is closed, so stray logs leak
// memory in production):
//   - Production builds strip console.log / console.debug / console.info via
//     esbuild `pure` annotations (removed by the esbuild minify pass).
//   - console.warn and console.error are deliberately KEPT — genuine failures
//     must still reach the retained buffer.
//   - Dev (`vite serve`) is untouched: all console levels work. Hot-path
//     per-render/per-event logs go through src/renderer/utils/debugLog.ts,
//     which is gated off by default even in dev.
//
// TAURI_ENV_DEBUG facts (probed empirically against @tauri-apps/cli 2.x on
// 2026-08-18 by hijacking beforeBuildCommand with an env-printing script):
//   - `tauri build` (release, the pos:tauri:build path): the var is NOT set.
//   - `tauri build --debug` / `tauri dev`: the var is the STRING "true".
// So compare against the string "true" — never rely on truthiness. If a future
// CLI starts exporting the string "false" for release builds, a truthiness
// check would read it as debug and silently ship an unminified bundle.
export default defineConfig(({ command }) => {
  const isDebugBuild = process.env.TAURI_ENV_DEBUG === 'true';
  const stripDebugConsole = command === 'build' && !isDebugBuild;

  return {
    plugins: [react()],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@renderer': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@config': path.resolve(__dirname, 'src/config'),
        '@services': path.resolve(__dirname, 'src/services'),
        '@lib': path.resolve(__dirname, 'src/lib'),
      },
    },

    // Vite options tailored for Tauri development
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      // Tauri expects a fixed port; fail if it's already taken
      watch: {
        // Tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },

    // Strip debug-level console calls and debugger statements from production
    // builds only. `pure` (unlike `drop: ['console']`, which also killed
    // console.warn/console.error) removes exactly the listed calls when the
    // esbuild minify pass runs.
    esbuild: stripDebugConsole
      ? {
          pure: ['console.log', 'console.debug', 'console.info'],
          drop: ['debugger'],
        }
      : {},

    // Build options
    build: {
      // Tauri v2 uses modern Chromium (supports ES2022+)
      target: ['es2022', 'chrome105', 'safari15'],
      // Don't minify for debug builds. Minify must stay 'esbuild' for release
      // builds or the `pure` annotations above are never acted on.
      minify: isDebugBuild ? false : 'esbuild',
      // Produce sourcemaps for debug builds
      sourcemap: isDebugBuild,
      outDir: 'dist',
    },

    // Polyfill process.env for Electron-era code that references it directly.
    // Vite doesn't provide process in the browser, but many copied Electron
    // files use process.env.NODE_ENV, process.env.SUPABASE_URL, etc.
    define: {
      'process.env': JSON.stringify({
        NODE_ENV: process.env.NODE_ENV || 'development',
      }),
    },

    // Environment variable prefix for client-side exposure
    envPrefix: ['VITE_', 'TAURI_ENV_'],
  };
});
