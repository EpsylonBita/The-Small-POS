# Settings modal review — 2026-09-07

Scope: `ConnectionSettingsModal`, its child setup screens, and the runtime consumers of the settings exposed there. This is separate from the memory/performance review. No production deployment, shop configuration reset, payment, receipt print or Caller ID transport change was performed.

## What changed

| Settings area | Verified connection and outcome |
| --- | --- |
| This till | Reads the local native configuration. Native `sync_health=polling` means recent successful configuration sync and is now green. Unknown is neutral and stale is amber. The card updates on `terminal-config-updated`. Opening Settings no longer starts a remote sync. Manual sync prevents duplicate requests and checks failure envelopes. Active areas can be expanded; administrator-managed permissions are explained. |
| Connection | Connection-code flow remains the production setup path; raw credentials remain dev-only. Credential writes and sync results must succeed before success feedback. The connection test remains dev-only; production help points to connection details and the administrator. |
| Printer | Profile setup, discovery, defaults, receipt prompt and queue commands have real native consumers. The receipt prompt checks save results. Screen & Sound links to this setup instead of saving an unused auto-print flag. No physical printing was performed. |
| Card machines | USB/serial and TCP paths remain available. Unsupported Bluetooth is visibly unavailable and cannot be saved/connected. Failed refresh/save responses no longer claim success or discard edits. |
| Waiter devices | Existing list/save API is connected, with terminal/organization restrictions enforced by the endpoint. No remote waiter configuration was changed. |
| Devices | Scale, customer display and serial scanner actions call native I/O, prevent repeated actions and refresh actual status. Saving connection details is distinguished from connecting hardware. Failed/partial saves retain unsaved state. Closing with unsaved changes offers Keep editing/Discard. MSR has no consumer and is labelled unavailable. Loyalty keyboard-listener status no longer promises NFC hardware detection. |
| Screen & Sound | The saved audio flag now controls order, kiosk and kitchen notification audio. Muting stops active app alerts; a test sound is available. Display/brightness, speaker volume, pointer/touch feedback and screen sleep open allowlisted Windows settings pages. Fake brightness/sensitivity/sleep controls were removed. Theme and language changes wait for successful persistence before success feedback. |
| PIN & lock | PIN persistence remains connected to native authentication. Removed unused custom timeout settings: native authentication currently uses 30 minutes of inactivity and a 2-hour maximum. The UI describes those rules without promising a configurable lock timer. Shift closure is separate. |
| Data | Existing recovery/reset commands remain connected with their confirmation and privilege checks. Reviewed without executing destructive actions. |
| Information | Native diagnostics and update entry point remain connected. Loading errors offer Retry; copying falls back to the native clipboard and reports failure. |

Navigation retains the existing section structure, with visible thin scrollbars for discoverability on shorter screens. New workflow copy is translated in English, Greek, German, French and Italian.

Within Devices, cash-register probes now distinguish reachable from connected. Explicit Connect/Disconnect use the existing native API; Test print requires a registered connection. The initial manager-only status snapshot restores already active connections without protocol polling. Read/save/delete failures are visible and preserve edits. Caller ID status read failures clear stale green UI without stopping or changing its production listener or central configuration.

Dirty-close confirmation uses the modal's request-close lifecycle: Escape and backdrop must not internally unmount the settings screen before Keep editing can cancel closure. A successfully saved audio toggle commits the known value directly to the shared audio store, stops muted playback immediately and invalidates older reads; a failed follow-up read cannot silently keep the old audio state.

## Boundaries and remaining hardware validation

- Configuration freshness is not the same signal as order queue, internet or overall System Health. A healthy local configuration can coexist with another subsystem warning.
- Windows controls the connected monitor's brightness capabilities and touch feedback. The POS does not implement panel brightness, touch calibration or physical sensitivity.
- `hardware_manager::apply_settings` is not invoked by the current save path. Save persists device preferences; individual Connect/Start actions establish supported native connections. A saved enabled flag is not proof of a connected device.
- The loyalty listener supports keyboard-style input; its running flag is not USB/NFC presence detection. Magnetic payment-card readers are not implemented by this setting.
- Native authentication checks session expiry during authentication/session validation; this change does not introduce a new continuous auto-lock timer or alter an active order's workflow.
- Physical scale/scanner/display, fiscal printer, payment terminal, monitor brightness and speaker output still require a device-level check. Automated bridge tests establish command/result contracts, not hardware certification.
- The local dev app restarted into an existing pending terminal rebind. Its native `settings_is_configured` returns false for that state. No credentials or rebind flags were changed to bypass onboarding; visual validation uses an isolated local fixture.

## Validation

Targeted tests cover configuration health, event cleanup, manual sync failure/pending state, hardware action refresh, unsaved changes (including actual modal Escape/backdrop lifecycle), audio preference/runtime cleanup, Windows-settings IPC allowlisting, payment-terminal/fiscal failure handling, Caller ID stale status, and theme/language persistence. The renderer regression run passes 88 tests across 13 files; the existing UI source suite passes all 52 checks. TypeScript, Vite production build, IPC parity and locale parity pass. Native allowlist tests compile and pass without opening Windows settings or touching the app database.

Greek visual inspection at 1280×800 verifies the green polling card, all ten navigation entries, Screen & Sound controls and dirty-device confirmation/Keep editing. Screenshots: `output/settings-modal/overview.png`, `screen-sound.png`, `navigation-bottom.png`, `unsaved-device.png`. Test/build logs and the isolated visual fixture are in the same directory.
