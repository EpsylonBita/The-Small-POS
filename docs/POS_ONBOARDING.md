# POS terminal onboarding

The first-run screen selects a persisted language, previews the destination in a
connection code, validates the terminal with Admin Dashboard, and synchronizes
settings before showing completion. Local recovery remains available as an
advanced action.

## Credential validation boundary

The connection code carries a candidate API key, terminal ID, and Admin Dashboard
origin. Decoding it does not authenticate the terminal. The native candidate
validation request is restricted to the settings GET for that candidate terminal.
It uses the candidate key and ID together, without requiring or borrowing the
currently stored terminal identity.

The response must establish matching terminal identity and authoritative
organization and branch IDs before the existing managed-credential publication
and recovery machinery runs. Validation failure must not replace credentials or
clear operational data. Main, mobile, and shared-terminal identity resolution
continues to distinguish authenticated source identity from owner identity.

Normal runtime API requests still require the managed terminal tuple. The
candidate validation path is not a general renderer-selected identity override.

## First-run failure in 1.4.103

Candidate validation used the ordinary authenticated transport before publishing
credentials. That transport required an already stored terminal ID, so a clean
installation failed before contacting the server. The React catch block read
only `error.message`, hiding native string rejections behind a generic message.

The bootstrap transport separates candidate validation from normal runtime
requests. The renderer normalizes errors from `unknown` and treats validation
and settings synchronization as separate stages. A failed required stage must
not write the configured hint or trigger the completion reload.

`ConfigGuard` keeps an active onboarding screen mounted when native credential,
configuration, or auth-pause events arrive before synchronization completes.
Already configured terminals retain their existing auth-pause recovery flow.
On a manual restart, native configuration detection still uses the persisted
credential tuple; this change does not introduce a durable setup-progress flag.

## Verification

- Use the local fake HTTP server and fake keyring for native candidate tests;
  never use an operating store's credentials as test fixtures.
- Cover an empty managed identity, replacement of an existing identity,
  rejected credentials, malformed/mismatched tenant binding, and the continued
  strict behavior of ordinary runtime requests.
- Exercise connection-code preview, native string errors, sync failures,
  retry, language persistence, and completion through renderer tests.
- Inspect the two steps and failure state at desktop and compact viewport sizes.
  Interaction animations respect reduced motion and use short transforms and
  opacity transitions.
- For live setup, choose the intended terminal explicitly and enter its full
  connection code in the POS. Keep API keys and full codes out of reports and
  screenshots intended for sharing.
