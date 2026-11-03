import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stage 3 of the Supabase key rotation: the renderer moves its clients (Realtime included)
// onto the publishable key the server handed this till, instead of the legacy anon JWT
// built into older releases, which stops working when the JWT-based keys are disabled.
const runtime = vi.hoisted(() => ({
  url: 'https://built-in.example.invalid',
  key: 'eyJbuilt-in-legacy-fixture',
  configure: vi.fn(),
}))

vi.mock('../../../shared/supabase-config', () => ({
  SUPABASE_CONFIG: {
    get url() { return runtime.url },
    get anonKey() { return runtime.key },
  },
  configureSupabaseRuntime: (url: string, key: string) => {
    runtime.configure(url, key)
    runtime.url = url
    runtime.key = key
    return true
  },
}))

vi.mock('../../../config/environment', () => ({
  environment: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
}))

import {
  SUPABASE_RUNTIME_KEY_EVENT,
  applyRuntimeSupabaseKey,
  currentSupabasePublicCredentials,
} from '../supabase-runtime-key'

describe('applyRuntimeSupabaseKey', () => {
  beforeEach(() => {
    runtime.url = 'https://built-in.example.invalid'
    runtime.key = 'eyJbuilt-in-legacy-fixture'
    runtime.configure.mockClear()
  })

  it('adopts the publishable key from the runtime config and announces it', () => {
    const announced = vi.fn()
    window.addEventListener(SUPABASE_RUNTIME_KEY_EVENT, announced)
    try {
      expect(applyRuntimeSupabaseKey({
        supabase_url: ' https://project.example.invalid ',
        supabase_publishable_key: ' sb_publishable_fixture_a ',
      })).toBe(true)
    } finally {
      window.removeEventListener(SUPABASE_RUNTIME_KEY_EVENT, announced)
    }
    expect(runtime.configure).toHaveBeenCalledWith('https://project.example.invalid', 'sb_publishable_fixture_a')
    expect(announced).toHaveBeenCalledTimes(1)
    expect(currentSupabasePublicCredentials()).toEqual({ url: 'https://project.example.invalid', key: 'sb_publishable_fixture_a' })
  })

  it('keeps the current URL when the config carries none', () => {
    expect(applyRuntimeSupabaseKey({ supabase_publishable_key: 'sb_publishable_fixture_a' })).toBe(true)
    expect(runtime.configure).toHaveBeenCalledWith('https://built-in.example.invalid', 'sb_publishable_fixture_a')
  })

  it('ignores configs without a publishable key and an unchanged key', () => {
    for (const config of [null, 'text', {}, { supabase_publishable_key: 'eyJlegacy-fixture' }, { supabase_publishable_key: 42 }]) {
      expect(applyRuntimeSupabaseKey(config)).toBe(false)
    }
    runtime.key = 'sb_publishable_fixture_a'
    expect(applyRuntimeSupabaseKey({ supabase_publishable_key: 'sb_publishable_fixture_a' })).toBe(false)
    expect(runtime.configure).not.toHaveBeenCalled()
  })
})
