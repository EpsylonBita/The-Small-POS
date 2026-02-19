import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
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

  // Build options
  build: {
    // Tauri v2 uses modern Chromium (supports ES2022+)
    target: ['es2022', 'chrome105', 'safari15'],
    // Don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
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
});
