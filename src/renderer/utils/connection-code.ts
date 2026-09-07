export interface DecodedConnectionCode {
  apiKey: string;
  adminUrl: string;
  terminalId: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function decodeConnectionString(connectionString: string): DecodedConnectionCode | null {
  try {
    const base64 = connectionString.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    ));

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      if (![value.key, value.url, value.tid].every((field) => typeof field === 'string' && field.trim())) {
        return null;
      }
      const apiKey = (value.key as string).trim();
      const adminUrl = (value.url as string).trim();
      const terminalId = (value.tid as string).trim();
      if (/\s/.test(adminUrl) || /[\u0000-\u001f\u007f]/.test(apiKey + terminalId)) return null;
      // A parsed code is only a preview, but it must name a valid HTTP server.
      const url = new URL(normalizeAdminDashboardUrl(adminUrl));
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(adminUrl) && !/^https?:\/\//i.test(adminUrl)) return null;
      const supabaseUrl =
        typeof value.surl === 'string'
          ? value.surl
          : typeof value.supabaseUrl === 'string'
            ? value.supabaseUrl
            : undefined;
      const supabaseAnonKey =
        typeof value.skey === 'string'
          ? value.skey
          : typeof value.supabaseAnonKey === 'string'
            ? value.supabaseAnonKey
            : undefined;

      return {
        apiKey,
        adminUrl,
        terminalId,
        supabaseUrl,
        supabaseAnonKey,
      };
    }

    return null;
  } catch {
    // Invalid input is expected while pasting/editing. Never log credential data.
    return null;
  }
}

export function looksLikeRawApiKey(value: string): boolean {
  const input = value.trim();
  if (!input || input.length < 24 || input.length > 80) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    return false;
  }
  return !input.startsWith('eyJ');
}

export function normalizeAdminDashboardUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(normalized);
    normalized = `${isLocalhost ? 'http' : 'https'}://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    parsed.search = '';
    parsed.hash = '';
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    parsed.pathname = cleanPath || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return normalized.replace(/\/+$/, '').replace(/\/api$/i, '');
  }
}
