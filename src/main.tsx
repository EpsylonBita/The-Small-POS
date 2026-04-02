import React from 'react';
import ReactDOM from 'react-dom/client';

function toOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Show fatal errors visually (since DevTools may not be open)
function showFatalError(err: unknown) {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  const root = document.getElementById('root')!;
  const container = document.createElement('div');
  container.style.cssText = 'color:#f87171;background:#1e293b;padding:32px;font-family:monospace;white-space:pre-wrap;max-width:800px;margin:40px auto';
  const heading = document.createElement('h2');
  heading.style.cssText = 'color:#fbbf24;margin-top:0';
  heading.textContent = 'Fatal Startup Error';
  const body = document.createElement('p');
  body.textContent = msg;
  container.appendChild(heading);
  container.appendChild(body);
  root.replaceChildren(container);
  console.error('[FATAL]', err);
}

async function hydrateStartupSupabaseContext(): Promise<void> {
  try {
    const { getBridge } = await import('./lib');
    const config = await Promise.race([
      getBridge().terminalConfig.getFullConfig(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('startup config hydration timed out')), 2500),
      ),
    ]);
    const terminalId = toOptionalTrimmedString(config?.terminal_id);
    const organizationId = toOptionalTrimmedString(config?.organization_id);
    const branchId = toOptionalTrimmedString(config?.branch_id);

    if (!terminalId && !organizationId && !branchId) {
      return;
    }

    const { setSupabaseContext } = await import('./shared/supabase-config');
    setSupabaseContext({
      terminalId,
      organizationId,
      branchId,
    });

    try {
      localStorage.removeItem('terminal_id');
      localStorage.removeItem('organization_id');
      localStorage.removeItem('branch_id');
    } catch {
      // Ignore storage errors in restricted contexts.
    }
  } catch (e) {
    console.warn('[Startup] Supabase hydration skipped (non-fatal):', e);
  }
}

try {
  // Global styles (must load before App)
  await import('./index.css');
  await import('./renderer/styles/globals.css');
  await import('./renderer/styles/glassmorphism.css');

  // Ensure screen capture IPC listeners are registered at startup
  await import('./renderer/services/ScreenCaptureHandler');

  // POS app entry
  const { default: App } = await import('./renderer/App');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <App />
  );
  void hydrateStartupSupabaseContext();
} catch (err) {
  showFatalError(err);
}
