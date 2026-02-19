/// <reference path="./renderer/types/electron.d.ts" />
import React from 'react';
import ReactDOM from 'react-dom/client';

// Show fatal errors visually (since DevTools may not be open)
function showFatalError(err: unknown) {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  document.getElementById('root')!.innerHTML = `
    <div style="color:#f87171;background:#1e293b;padding:32px;font-family:monospace;white-space:pre-wrap;max-width:800px;margin:40px auto;">
      <h2 style="color:#fbbf24;margin-top:0;">Fatal Startup Error</h2>
      <p>${msg}</p>
    </div>`;
  console.error('[FATAL]', err);
}

try {
  // IPC abstraction layer -- must run before React renders
  const { installElectronCompat, startEventBridge } = await import('./lib');

  // Install window.electron / window.electronAPI shim so existing Electron POS
  // components work unchanged inside Tauri.
  installElectronCompat();

  // Bridge Tauri push-events into the Electron-compatible eventBus.
  startEventBridge();

  // Hydrate frontend Supabase client with credentials from the secure store.
  // This must happen before React renders so components can use Supabase.
  try {
    const config = await (window as any).electronAPI?.invoke?.('terminal-config:get-full-config');
    if (config?.supabase_url && config?.supabase_anon_key) {
      const { configureSupabaseRuntime } = await import('./shared/supabase-config');
      configureSupabaseRuntime(config.supabase_url, config.supabase_anon_key);
      console.log('[Startup] Supabase configured from terminal credentials');
    }
    // Also store terminal context for Supabase headers
    if (config?.terminal_id || config?.organization_id || config?.branch_id) {
      const { setSupabaseContext } = await import('./shared/supabase-config');
      setSupabaseContext({
        terminalId: config.terminal_id,
        organizationId: config.organization_id,
        branchId: config.branch_id,
      });
      // Also stash in localStorage for hydration on reload
      if (config.terminal_id) localStorage.setItem('terminal_id', config.terminal_id);
      if (config.organization_id) localStorage.setItem('organization_id', config.organization_id);
      if (config.branch_id) localStorage.setItem('branch_id', config.branch_id);
    }
  } catch (e) {
    console.warn('[Startup] Supabase hydration failed (non-fatal):', e);
  }

  // Global styles (must load before App)
  await import('./index.css');
  await import('./renderer/styles/globals.css');
  await import('./renderer/styles/glassmorphism.css');

  // Ensure screen capture IPC listeners are registered at startup
  await import('./renderer/services/ScreenCaptureHandler');

  // The real POS app from the copied Electron renderer
  const { default: App } = await import('./renderer/App');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <App />
  );
} catch (err) {
  showFatalError(err);
}
