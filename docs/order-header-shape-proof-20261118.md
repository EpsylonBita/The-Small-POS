# Customer-header item comparison: 18 November 2026 D1 follow-up

Scope: desktop only, bounded D1 follow-up; no server/shared edits, commit or deployment. Worker: native OpenAI Codex (GPT-6 family), no delegated workers.

## Correction to the incident attribution

Tomikro's manual line did **not** differ from the hydrated GET line under the pre-existing signature. `edit_settlement_recovery::customizations` already removes the entire `_meta` member, then canonicalizes empty arrays/objects/null to null. Its `line_signatures` defaults absent original price to unit price and absent override to false.

| Signature field | Till | Hydrated GET |
| --- | --- | --- |
| menu / retail | null / null | null / null |
| quantity | 1.0 | 1.0 |
| unitCents / totalCents | 1450 / 1450 | 1450 / 1450 |
| originalUnitCents | 1450 (explicit 14.50) | 1450 (defaults to unit price) |
| overridden | false (explicit) | false (default) |
| name / notes | same stored name / null | same stored name / null |
| customizations | null (from `[]`) | null (after removing `_meta`) |

There was no manual marker in that signature. The D1 marker offered no additional money or product-identity protection, and could refuse an old line with no marker on one side. It and the redundant manual-only metadata stripping are removed. The eager admission fallback remains the proven cause of the native `REMEDY_NOT_APPLICABLE`; the historical timeline does not establish a separate item refusal. The prior incident table is corrected, not retained as a hypothesis.

## Real producers and the three shapes

Sources read: `src/shared/utils/pos-order-items.ts::normalizePosOrderItem`, `src/services/OrderService.ts::createOrder`, `src/renderer/components/modals/MenuModal.tsx` combo/manual builders, `ProductCatalogModal.tsx` product/deposit builders, `src/renderer/pages/verticals/salon/salon-sale.ts::serviceSaleLine`; native `sync_queue::normalize_order_insert_items`, `project_insert_ack_lines`, `adopt_item_edit_ack`, `edit_settlement_recovery::lines_with_client_ids`, `commands/orders.rs::canonical_item_edit_payload`, and `sync.rs` materialize/refresh paths. Read-only server sources: sync route `normalizePosOrderItemsForSync`, `hydrateOrderItemsForPos`, exact lookup; `PosOrdersApiService.mapOrderItemsForInsert` and `mapOrderItem`; `pos-order-menu-item-sanitizer.ts`.

Common till create shape **L**: original cart `id`, `name`/`menu_item_name`/`menuItemName`; `menu_item_id`/`menuItemId`; numeric `quantity`; `price`/`unit_price`/`unitPrice`; `total_price`/`totalPrice`; `original_unit_price`/`originalUnitPrice`; boolean `is_price_overridden`/`isPriceOverridden`; `customizations`; optional `notes`, instructions aliases; category aliases; manual aliases; service/appointment IDs (null if absent), VAT/fiscal aliases. The normalizer spreads other supplied fields. The native create stores the supplied items JSON, not a fresh DB-row reconstruction.

Common raw shape **R**: server line UUID `id`, `order_id`, nullable `menu_item_id`, `retail_product_id`, `menu_item_name`, `quantity`, `unit_price`, `total_price`, nullable `original_unit_price`, boolean `is_price_overridden`, `notes`, object `customizations` including `_meta: {product_name, category_id, category_name, line_kind}`; stored fiscal fields and applicable vertical IDs. SQL schema columns not supplied by the insert mapper have their database null/default values. Our fixtures include `is_combo=false`, null combo ID/contents (migration `20260128192309_menu_combos_system.sql`), and boolean `is_voided` explicitly; they do not invent omitted column values.

Common hydrated shape **H** (actual GET function): `id`; nullable `menu_item_id` and `menuItemId`; `menu_item_name`/`menuItemName`/`name` resolved from stored name, then menu catalogue, then `Item N`; numeric `quantity`; `unit_price`/`unitPrice`/`price`; `total_price`/`totalPrice`; `notes` (null if absent), `special_instructions` (null if absent); `customizations` unchanged or null; category name/path snake/camel aliases. The current ordinary hydrator omits original price, override, manual flags, combo fields, and arbitrary metadata. It carries non-null VAT category/rate, price-includes-VAT, exemption, fiscal profile, line role and staff, plus truthy retail/service/appointment/variant IDs. Both returned arrays filter `is_voided === true`.

| Kind | Till at create (in addition to L) | Hydrated `items` (in addition to H) | Raw `order_items` (in addition to R) |
| --- | --- | --- | --- |
| Menu + ingredients | `menuItemId` is menu/subcategory UUID; `customizations` array of selections with `ingredient.id`, quantity and selection flags; cached ingredient decorations possible | Same menu UUID; customization object keyed by ingredient ID, includes server `_meta` | Same selected ingredient objects, keyed by native writer; `_meta.line_kind=item` |
| Manual | `id=manual-...`, both manual flags true, menu IDs null, `customizations=[]`, original 14.5, override false | Menu null; no manual flags, original or override; `_meta` retained | Menu null, original 14.5, override false; `_meta.line_kind=manual_item` |
| Price overridden | Unit 12, original 14.5, override true (both aliases) | Unit 12; **no original/override fields** | Unit 12, original 14.5, override true |
| Combo | `id=combo-...`, `menuItemId=combo.id`, `is_combo=true`, `combo_id`, `combo_type`, `combo_items[{subcategory_id,name,name_en,name_el,quantity,unit_price}]` | No combo fields | Current native insert normalizer and server mapper do not write combo fields. An unresolved combo UUID is nulled by the menu sanitizer. Stored legacy combo fields, when present, are returned raw, omitted by H |
| Deposit | `id=manual`, menu null, manual true, `line_role=deposit`, product VAT, quantity follows product | `line_role=deposit`, supplied fiscal facts; no manual flags | `line_role=deposit`, menu null, `_meta.line_kind=manual_item` |
| Retail / variant | `id=product UUID`, menu ID and `retail_product_id` both product UUID; optional `retail_variant_id`; fractional quantity supported | Menu null, `retail_product_id`, truthy `retail_variant_id` | Sanitizer moves retail identity out of menu ID; explicit retail/variant IDs retained |
| Service / appointment | Menu null, `service_id`, nullable `appointment_id`, `staff_id`, `metadata.staff_name`; original price; quantity 1 | Service ID, truthy appointment ID, staff ID/fiscal facts; metadata omitted | Same service/appointment/staff identities, stored original price and override, `_meta.line_kind=item` |
| Notes | Normalizer writes `notes` from notes/instructions aliases | `notes` preserved, null if absent | `notes` preserved, null if absent |
| Quantity > 1 | Numeric quantity, unit price, total (unit x quantity unless explicit); native rounds quantity to 3 decimals | Same quantity/unit/total | Same quantity/unit/total |
| Voided line | Current pull replaces items with active lines; stale pre-void local snapshot still includes old line | Voided line excluded | Voided line excluded by `hydrateOrderItemsForPos`, despite `order_items(*)` initially selecting it |

After a create ACK, `project_insert_ack_lines` calls the real `lines_with_client_ids`: it replaces the entire matching line with the returned canonical line and preserves former cart identity as `client_line_id`. It does not merely patch `id`. If matching fails, it retains local items. Pull/materialize/refresh prefers H over R and stores it as JSON, losing original-price/override fields. The API acknowledgement mapper `mapOrderItem` produces UUID `id`, menu/retail/service/appointment/variant/staff/line-role fields, quantity, price/unit/original/override/total, fiscal fields, `name` resolved also from `_meta.product_name`, category/subcategory data, customizations with `_meta` removed, and notes. An item-edit ACK validates returned line identity/product/quantity, then stores these returned API `items`; an offline/local item edit retains its merged request shape until acknowledgement. None of these is a single permanent local schema.

The generated matrix uses the actual create-ACK matching function, including retention when matching fails. It executes `mapOrderItem` to model edit ACK storage; it does not execute checkout, server pricing, item-edit HTTP, or a database insert on production.

## Decision and boundary

`drift` keeps H as its source for all existing comparison fields. It supplements **only** `original_unit_price` and `is_price_overridden` from R by matching server line UUIDs; it never pairs rows by position. Missing, duplicate or inconsistent relation IDs fail closed. A raw null name therefore cannot undo a correctly hydrated name. `_meta` remains handled by the existing settlement normalizer. Financial edit settlement itself is unchanged.

A local explicit original price/override is compared to the supplemented fact, including explicit false. A pulled/legacy local line without that field provides no historical evidence for it; it is not turned into a false claim that the original was current unit price or the override was false. The other established fields remain mandatory. Multiset matching preserves duplicate-line counts and finds a one-to-one pairing even when one old line lacks pricing metadata and a second line retains it. A hydrated-only legacy answer keeps the old conservative refusal for an explicitly retained non-default override.

This is a limited supplement, **not** global raw-row comparison. The regression proves a null stored name hydrated from the catalogue, manual flag absence, and a pulled overridden line all remain editable with the actual exact-route answer. Changed unit/total price, quantity, retained original/override, menu/retail identity, actual modifiers, added/removed lines still refuse in both native verification paths. Names/notes retain existing semantics: ordinary edits refuse their drift; the notice remedy may adopt them.

Limits to the proof, for coordinator review:

- When the local pull already discarded original/override history, no comparison can establish a historical change confined to those missing fields. This patch does not reconstruct history or claim it does. Current unit price, total, quantity and actual modifiers remain compared. A durable pull-contract fix would be separate work.
- The existing signature does not include `retail_variant_id`, `service_id`, `appointment_id`, `line_role`, `combo_id`/contents, or fiscal metadata. These fields do not introduce false refusal here, but changes confined to them are not proven protected. The pre-existing comparator also ignores replacement line UUIDs when the entire compared sale multiset is identical. This follow-up does not widen financial/identity semantics silently.
- Retail/variant pre-ACK snapshots with the product UUID in both menu and retail fields still disagree with the sanitized menu-null server shape. `lines_with_client_ids` can retain that original instead of projecting the ACK. The matrix explicitly expects this pre-existing refusal; after canonical edit/pull shapes, comparison passes. It is not a regression introduced by selecting H.
- Combo cart production is real, but neither inspected native/server insert mapper persists combo identity/contents. The native menu-cache check can already refuse a combo UUID; if it reaches the server (for example with an empty menu cache), the unknown UUID can be cleared as a non-catalogue menu reference; create/ACK snapshots then refuse as before. The fixture reproduces that route, not an invented successful combo persistence contract. Acceptance of a historical raw combo row is tested separately; selling/persisting a complete combo end to end is **not verified**.
- Raw-only diagnostic comparison intentionally demonstrates the missing-name problem. The real exact GET returns both arrays; a raw-only `items` envelope is not claimed to be that route's wire response.

## Regressions and reproducibility

`node scripts/generate-order-header-shape-fixtures.cjs --check` checks the fixture against executing the current pure TypeScript mappers extracted read-only from source. The generator uses the actual local normalizer, server insert and acknowledgement mappers, and GET hydrator, with explicit representative computed-price inputs; it does not simulate server pricing/catalogue queries. Sanitizer and void filtering inputs are documented in the generator. Source extraction fails if required declarations disappear. `tests/scripts/order-header-shape-fixtures.test.ts` runs this check in the default desktop parity suite so mapper drift is a blocking failure rather than an opt-in generator check.

`order_header_preflight_route_line_kinds_at_create_ack_pull_and_edit` runs migrated SQLite capture plus both `verify_detailed` and `order_notice_recovery::verify`, for 13 cases, four local stages and three projections, with ten protected mutations and two adoptable display mutations per kind (312 scenario pairs), plus a stale local snapshot retaining a voided line. The matrix has 626 verification calls (312 pairs plus the stale-void pair). The separate Tomikro equality regression calls the pre-existing settlement signature directly. Mixed known/missing duplicate lines exercise one-to-one matching rather than greedy consumption. Additional tests cover older missing manual markers, stored combo-column omission, and reordered/invalid raw relation IDs.

The earlier Tomikro negative customization fixture now changes both GET projections, as the real hydrator preserves customizations verbatim; mutating only R while keeping an inconsistent H was not a faithful route answer.

Final checks (one heavy command at a time; cargo used `CARGO_BUILD_JOBS=5`, `CARGO_TARGET_DIR=D:/trae/The-Small-002/pos-tauri/src-tauri/target`, and `TEMP`/`TMP=D:/trae/The-Small-002/pos-tauri/src-tauri/target/t`):

- `cargo fmt --check`: passed.
- `cargo test --lib --no-fail-fast -- order_header_preflight order_notice edit_settlement commands::orders commands::recovery`: **296 passed, 0 failed, 0 ignored, 4841 filtered out**, 148.50 seconds in tests.
- `node --test tests/scripts/order-header-shape-fixtures.test.ts`: **1 passed, 0 failed, 0 skipped**.
- `node scripts/generate-order-header-shape-fixtures.cjs --check`: **13 generated cases match the current mappers**.
- `git diff --check -- pos-tauri`: passed. All seven files written in this follow-up were checked as UTF-8/LF; existing non-ASCII comments were reread.

The first focused run was 293 passed / 1 failed / 4841 filtered: the new fixture had incorrectly treated create acknowledgement items as raw relation rows in the null-name case. Executing the actual `mapOrderItem` fixed that test input; it did not require loosening production comparison. Two additional regression tests brought the final count to 296. The whole library suite, checkout hardware, deployed till and full server pricing execution were not run. No renderer files changed in this follow-up; the earlier D1 renderer/parity/locale/typecheck results are separate from these follow-up checks.
