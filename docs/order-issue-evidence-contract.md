# Desktop order issue evidence: Android contract alignment

17 November 2026. This supersedes the evidence wire format in the earlier desktop automatic-attempt report. Automatic/manual remedy behavior and the delivered gate are unchanged. Android and Landing files were read only; no cross-app import, server change, generated-catalogue change or commit was made.

## Contract sent

Each kind/code pair uses `issueCode: sync.active_error` and fingerprint:

`<terminal>:sync.active_error:order_issue:<issue_kind>:<refusal_code>`

The normal general `sync.active_error` and `sync.blocked_backlog` candidates remain separate. The order-issue prefix selects its own evidence source for failed-read protection, so an unreadable general sync summary cannot prevent clearance of a freshly resolved order issue, and an unreadable order-issue read cannot clear its fingerprint. The old `sync.order_issue_open` code is retained only as a read-side source mapping to close previously reported fingerprints after upgrade; no new report uses it.

`evidence` contains:

- `order_issue_count`: total entries for this fingerprint.
- `order_issues`: the first 50 entries.
- `order_issue_pages`: remaining entries, in recursively nested arrays with at most 50 children each. Omitted when there is no overflow, matching Android. Neither a long page list nor a page exceeds the existing sanitizer limit.

Each entry contains exactly these nine fields:

```json
{
  "issue_kind": "customer_correction_refused",
  "refusal_code": "ORDER_EDIT_BASE_UNAVAILABLE",
  "table_name": "orders",
  "operation": "update",
  "shape_class": "header-only",
  "automatic_attempt": {
    "ran": true,
    "outcome": "failed",
    "reason": "EDIT_CANONICAL_ORIGINAL_CHANGED"
  },
  "employee_attempt": {
    "ran": false,
    "outcome": "not_run",
    "reason": "NOT_ATTEMPTED"
  },
  "open_for_ms": 60000,
  "app_version": "1.4.152"
}
```

This is an illustrative entry, not a submitted production incident. Ages are calculated in milliseconds, including sub-second timestamp precision. Original opening time and refusal reason continue to follow retained replacement evidence. Missing refusal evidence is `UNCLASSIFIED_REFUSAL`; a wait without refusal evidence is `AWAITING_CONFIRMATION`. A failed replacement prefers its current retained refusal code.

Table aliases normalize to `orders`, `order_payments` or `payment_adjustments`, including both parity `payments` and financial `payment`. Operations are lower-case `insert`, `update` or `delete`. Shapes remain `header-only`, `items`, `settlement`, `money`, with the accepted `other` fallback for unknown/status/driver shapes.

Attempts have only `ran`, `outcome`, `reason`. Local audit outcomes are projected to `not_run`, `pending`, `failed`, `confirmed`, `set_aside` or `unknown`; internal `running` becomes `pending`, and `resolved`/`verified`/`succeeded` become `confirmed`. The internal audit schema and renderer action requests are unchanged. No request values, order/customer identifiers, contents or raw messages enter these entries.

The existing admission/update/clearance behavior is retained: two observations, short automatic saves do not open a new report, pending proof retains an already-open fingerprint, changed attempt evidence updates its fingerprint, age-only changes do not cause reports, and two fresh clear observations resolve it. These decisions flatten all overflow pages; the 51st issue can neither be hidden from admission nor omitted from change detection.

## Files and verification

Changed files:

- `src-tauri/src/order_notice_evidence.rs`: projection, names/units/values, paging and independent admin-consumer contract tests.
- `src-tauri/src/incident_reporting.rs`: fingerprint, grouping, paged lifecycle decisions and independent-source/clearance tests.
- `src-tauri/src/order_notice_recovery.rs`: native projection assertions and a financial wait regression for normalized table, operation, marker and millisecond age.
- This report.

The consumer-contract test copies the documented Landing fixture/expectations rather than importing another app. It parses the first 50 plus recursively nested pages, verifies all nine fields and attempt enums, and reproduces the 53-entry aggregation: 52 updates, one insert, oldest age 123456 ms, versions 1.2.3 and 1.2.4, and the expected attempt counts. Paging tests cover 0, 1, 50, 51, 2551 and 5003 entries.

Commands from `pos-tauri/src-tauri/`, with `CARGO_BUILD_JOBS=5` and `CARGO_TARGET_DIR=D:/trae/The-Small-002/pos-tauri/src-tauri/target`:

```text
cargo test --lib -- order_notice_evidence incident_reporting::tests order_notice_recovery
cargo fmt --check
```

Results: the final selected Rust run passed all 61 tests (0 failed, 4986 filtered out); `cargo fmt --check` passed. Scoped `git diff --check` passed. No full Rust suite, renderer suite, live incident submission or admin-app execution was performed for this native contract alignment. No commits were made.
