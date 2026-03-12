export interface DecodedConnectionCode {
  apiKey: string;
  adminUrl: string;
  terminalId: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function decodeConnectionString(connectionString: string): DecodedConnectionCode | null {
  try {
    const base64 = connectionString.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);

    if (parsed.key && parsed.url && parsed.tid) {
      const supabaseUrl =
        typeof parsed.surl === 'string'
          ? parsed.surl
          : typeof parsed.supabaseUrl === 'string'
            ? parsed.supabaseUrl
            : undefined;
      const supabaseAnonKey =
        typeof parsed.skey === 'string'
          ? parsed.skey
          : typeof parsed.supabaseAnonKey === 'string'
            ? parsed.supabaseAnonKey
            : undefined;

      return {
        apiKey: parsed.key,
        adminUrl: parsed.url,
        terminalId: parsed.tid,
        supabaseUrl,
        supabaseAnonKey,
      };
    }

    return null;
  } catch (error) {
    console.error('Failed to decode connection string:', error);
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
