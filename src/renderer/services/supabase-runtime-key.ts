import { SUPABASE_CONFIG, configureSupabaseRuntime } from '../../shared/supabase-config';
import { environment } from '../../config/environment';

/** Fired on window after the renderer adopted a new Supabase public key. */
export const SUPABASE_RUNTIME_KEY_EVENT = 'supabase-runtime-key-updated';

const PUBLISHABLE_KEY_PREFIX = 'sb_publishable_';

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The Supabase URL and public key the renderer's clients use: the publishable key the
 * server handed this till once adopted, else the key built into this release.
 */
export function currentSupabasePublicCredentials(): { url: string; key: string } {
  return {
    url: SUPABASE_CONFIG.url || environment.SUPABASE_URL,
    key: SUPABASE_CONFIG.anonKey || environment.SUPABASE_ANON_KEY,
  };
}

/**
 * Adopts the publishable key from a terminal runtime config (`supabase_publishable_key`,
 * which the native side exposes only for an sb_publishable_ key). The legacy anon JWT built
 * into older releases stops working when the project's JWT-based keys are disabled, and a
 * rotated publishable key then needs no new build. Returns true when the key changed.
 */
export function applyRuntimeSupabaseKey(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const record = config as Record<string, unknown>;
  const key = trimmedString(record.supabase_publishable_key);
  if (!key.startsWith(PUBLISHABLE_KEY_PREFIX) || key === SUPABASE_CONFIG.anonKey) return false;
  const url = trimmedString(record.supabase_url) || currentSupabasePublicCredentials().url;
  if (!configureSupabaseRuntime(url, key)) return false;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SUPABASE_RUNTIME_KEY_EVENT));
  }
  return true;
}
