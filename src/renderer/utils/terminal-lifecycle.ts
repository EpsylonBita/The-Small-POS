type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export interface TerminalResetPresentation {
  clearLocalSession: true;
  keepConfigured: false;
  message: string;
}

export interface TerminalAuthPausePresentation {
  clearLocalSession: false;
  keepConfigured: true;
  message: string;
  requestedTerminalId: string | null;
  canonicalTerminalId: string | null;
}

function normalizeTerminalId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function translate(
  t: TranslateFn,
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  const translated = t(key, { defaultValue: fallback, ...options });
  if (typeof translated === 'string' && translated && translated !== key) {
    return translated;
  }
  return fallback;
}

export function resolveTerminalResetPresentation(
  reason: string | undefined,
  t: TranslateFn,
): TerminalResetPresentation {
  let message = translate(
    t,
    'system.remoteWipe',
    'Terminal has been reset remotely',
  );

  if (reason === 'terminal_deleted') {
    message = translate(
      t,
      'system.terminalDeleted',
      'This terminal has been deleted from the admin dashboard. Please reconfigure.',
    );
  } else if (reason === 'terminal_inactive') {
    message = translate(
      t,
      'system.terminalInactive',
      'This terminal has been disabled in the admin dashboard. Please contact an operator or restore access.',
    );
  } else if (reason === 'admin_command') {
    message = translate(
      t,
      'system.factoryReset',
      'Factory reset command received from admin dashboard.',
    );
  }

  return {
    clearLocalSession: true,
    keepConfigured: false,
    message,
  };
}

export function resolveTerminalAuthPausePresentation(
  payload: {
    requestedTerminalId?: unknown;
    canonicalTerminalId?: unknown;
  },
  t: TranslateFn,
): TerminalAuthPausePresentation {
  const requestedTerminalId = normalizeTerminalId(payload.requestedTerminalId);
  const canonicalTerminalId = normalizeTerminalId(payload.canonicalTerminalId);

  const message =
    requestedTerminalId && canonicalTerminalId
      ? translate(
          t,
          'system.remoteAuthPausedWithIds',
          'Remote sync is paused because the stored terminal identity is out of sync. Requested {{requestedTerminalId}}, expected {{canonicalTerminalId}}.',
          {
            requestedTerminalId,
            canonicalTerminalId,
          },
        )
      : translate(
          t,
          'system.remoteAuthPaused',
          'Remote sync is paused because the stored terminal identity is out of sync. Refresh terminal settings or reopen connection settings.',
        );

  return {
    clearLocalSession: false,
    keepConfigured: true,
    message,
    requestedTerminalId,
    canonicalTerminalId,
  };
}
