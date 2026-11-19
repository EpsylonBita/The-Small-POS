# Till health on Windows

The rail, Settings and order details open the same Till health window. The rail and Settings use the same state as its headline. Ordinary print setup and periodic live-update fallback stay out of the headline. Order details can open the window with the selected order first.

The window uses `buildSyncRecoveryIssues` and its business-event keys. The staff copy is closed over known issue families. Native IDs, technical messages and actions are in the support disclosure. The support report and the backup tools share that disclosure.

## State and verification

| State | Evidence |
| --- | --- |
| Ready | A complete current read and no card requiring attention. A missing shift is explained separately. |
| Attention | An issue offers a specific permitted action, or the open day is overdue. Known decisions appear before generic refusals. |
| Working | The selected action is running through its existing owner. |
| Pending | The action acknowledged a request without positive proof, or the till reports existing work awaiting confirmation. |
| Solved | Native verification passed for the selected target, or the original sending attempt positively acknowledged every selected row. The card shows the confirmation time and leaves. |
| Support needed | The selected issue has no suitable staff action, an attempted action was refused, or remote support could not start. |
| Offline | The till reports no connection. Local work and what waits remain visible. |
| Old or unavailable | A required read failed or the last complete view expired. A previous complete view keeps its cards, marked as old. An initial failed read shows the state as unconfirmed. |

The action hook delegates to the existing snapshot, PIN and action owners. It keeps a pre-emption outcome on the same card and offers the same action again. It preserves a pending card after an observation stops listing it until the till positively confirms the matching change.

## Where controls live

| Previous control | Location in Till health |
| --- | --- |
| Status heart, capacity warning, Settings backup entry and issue review | The same window. |
| Status refresh and six service tiles | Check again and the six rows in The till now. |
| Send waiting changes, printer settings and terminal connection settings | A staff action where eligible, and the existing tools in For support. The old offline send attempt is also available in the tools. |
| Customer correction and keeping the existing details | The selected order card, with the second decision under a quiet disclosure. |
| Other issue actions, including exact sending, validation, removal, money fixes and customer merge | The individual issue's controls in For support, with their existing checks and confirmations. |
| Report and diagnostics copy | New report. Selecting an issue can include the corresponding evidence. Previous copies opens the archived report's folder using the existing native open-folder command. |
| Support code, consent, end connection, and support changes | Ask for support starts the existing code flow. The code and support controls are displayed inside For support. |
| Z set-aside, return, retained table attempts, financial details, snapshots, restore and quarantine | Support tools. Tracked payment and shift approvals stay with their existing owners. Onboarding retains its own backup controls because the till window is unavailable before setup. |

## Diagnostics report delivery

The desktop Health report command saves a redacted ZIP and commits its file name, SHA-256, creation time, pairing and state to a separate diagnostics journal in app data. The report worker checks native reachability at startup and during service. It defers new uploads during critical operations and never owns a checkout, payment, shift or Z gate. The exact bytes stay on the till after delivery.

A storage receipt must name the incident, confirm ZIP storage and match the recorded SHA-256. Connection failures before a request leaves the till and HTTP 429 use bounded backoff. A terminal refusal leaves the ZIP available to Support. A lost response or an interrupted upload leaves delivery unconfirmed. The terminal incident API currently offers no receipt lookup for a closed or ambiguous report, so the desktop leaves that copy for Support review without posting it again.

Previous copies include the till's existing diagnostics ZIPs and incident records. An earlier entry without a receipt tied to the ZIP remains a local copy or record. The pairing-bound outbox is removed with app data on factory reset.
