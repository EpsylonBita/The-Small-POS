# Store module caches (phase 3)

The terminal-authenticated enabled-modules endpoint owns optional access. Its
pre-migration organization-wide behavior needs no client compatibility union.
The terminal allowlist remains server-owned, including its NULL/empty semantics.

Native entitlement files use a SHA-256 discriminator of organization, store,
terminal and API origin. `storeScopeVersion: 3` is required: earlier caches,
including branch-bound organization-wide lists, cannot grant access after the
ownership backfill. Every native reader uses the same identity check, including
offline check-in and stored Z presentation. Only a full native endpoint response
can publish the new format. Renderer cache-save calls cannot mint access.

The renderer uses the same identity tuple and a new localStorage namespace.
Store-setting events invalidate the visible list immediately, fence outstanding
requests, and schedule another full request after the old request settles. An
empty authoritative response leaves core screens available. Complete product and
inventory snapshots already bind organization/store/terminal; optional warmup
also requires the native envelope's store to match its requested configuration.

Module-bearing settings/bootstrap and entitlement routes never fall back to the
generic admin GET cache. Dedicated local settings and complete snapshots retain
their offline behavior. No order, payment, financial or module action queue is
deleted by entitlement invalidation. Repairs retains its separate native gate.

The Android counterpart is documented in
`POSSystemMobile/docs/store-modules-phase3-cache-scope.md`. Both apps must ship
before the ownership migration. Installed-device re-pairing and offline recovery
remain device acceptance checks; the implementation tests do not certify hardware.
