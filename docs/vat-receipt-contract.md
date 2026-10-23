# Desktop order VAT and receipt display

Each order stores one computed VAT amount. `fiscal/greece_vat.rs` mirrors the
shared order calculator and runs all shared order VAT vectors. Country,
registration, default category and region come from the branch's `tax` settings:
`vat_country`, `vat_registered`, `vat_default_category_code` and
`vat_region_profile`. Manual items without a category use that branch policy.
Service carts convert net catalogue prices through the shared service-price
helper, including Swiss rates in tenths of a percent.

The Z sums stored order VAT over its existing counted-order scope, preferring
`tax_amount_cents`. Neither receipt settings nor the owner rate affect this sum.
Previously stored Z reports remain unchanged.

Receipts and saved-order screens show computed VAT only when a native fiscal
plugin/device is active or `tax.vat_print_on_receipt` is on. When the switch is
missing, a valid positive `tax.default_tax_rate` enables printing. That rate
never recalculates the displayed VAT. Zero VAT has no printed line.

For an unsaved cart, `MenuPage` retains item fiscal fields and explicit unit
prices through normalization. `CartSummary` uses the shared order calculator
and submits its displayed discount. Its print gate combines the switch with a
local native read: `settings:get('tax', 'vat_receipt_fiscal_active')`. This
boolean is derived by `settings_get` through `PrintedVatContext::fiscal_active`;
it is never persisted or synced. The menu reads it on mount, settings changes
and every 30 seconds, without an admin request. Saved orders receive their
native `printedVatAmount` instead.

SQLite v105 adds `orders.tax_breakdown` (camelCase monetary buckets). Local
create/edit writes persist it with VAT; server adoption preserves the server's
breakdown. The renderer and Rust read all v3 profile feed keys, including class
rows, four channel defaults, platform opt-ins, charges mode, delivery override
and Swiss tip turnover. Malformed JSON maps are empty; absent keys retain the
previous fixed-fee behavior. Island rates are explicit codes, never remapped.

Sale channel uses only the order's fulfillment and `platform`/`plugin` column;
`source` and `ghost_source` (QR, kiosk recovery) never select platform VAT.
Menu/service/retail lines retain `vat_class`; combos remain one line and their
components are not synthesized into order lines.

Unregistered branches suppress receipt VAT and the VAT number. Swiss slips
that print VAT suffix line prices with letters and show the corresponding
rate legend under items, plus the channel marker and delivery address. The Z
freezes `vatBreakdown` over the same counted orders as its stored-VAT sum;
unknown old rates stay unknown, and VAT tables reconcile to stored order VAT.
New Z prints show rate/channel net, VAT and gross, channel order counts and
tips outside VAT. A zero-VAT Z has no VAT section. Stored Zs are never rewritten. The shared order and receipt fixtures are the
cross-platform contract; Android integration remains owned by its worker.

Build follow-up owned by the coordinator: this worker observed
`src-tauri/build.rs` still watching `../.git/HEAD`, which is missing in this
worktree. That reruns the script, changes `BUILD_TIMESTAMP` and recompiles the
crate for every filtered test command. Resolve actual Git watch paths through
`git rev-parse --git-path` and watch existing paths only. This worker's brief
explicitly prohibits editing `build.rs`.
