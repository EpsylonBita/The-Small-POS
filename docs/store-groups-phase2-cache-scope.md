# Desktop shared cache scope (phase 2)

The terminal settings API owns the group. Only `branch_info.group_id` is accepted;
null or absent means the organization is its single group. Customer rows, staff,
phones, orders and renderer claims never select a group.

`group_scope.rs` persists the derived cache binding in native-only terminal
`group_*` settings. These are cache metadata, not connection credentials. The
organization, terminal and store still come from the checked keyring publisher.
Migration 109 captures their existing values before SQLite write admission,
because installed tills have already purged plaintext credential mirrors.
A terminal rebind clears the derived binding and refreshes it from authenticated
settings after the rebind completes.

## Cache identities

`db::get_setting` / `set_setting` / `delete_setting` map shared logical keys to
`shared_v2:[organization,groupKey,terminal]:logicalKey`. Explicit physical keys
are idempotent, including the native legacy PIN redactor. This covers the
customer directory, nested addresses, local aliases and privacy cleanup, loyalty
snapshot markers, shared admin-GET responses and staff directory entries. Staff
entries also retain their eligible store key. Supplier invoices, payments,
captures, orders, shifts and drawers retain their existing store scope.

The historical `branch_ops_cache.branch_id` cache column holds
`group:[organization,groupKey,terminal]` for coupon catalogues. It continues to
hold a store ID for operational datasets. Coupon validation only sees the active
catalogue. The PIN vault uses the same organization/group/terminal namespace;
it holds one credential per person. Staff `branch_ids` must include the current
store when provided. Missing assignments preserve older-server behavior;
malformed or empty assignments refuse local eligibility. Online-first PIN
verification and the five-attempt, fifteen-minute offline lockout are unchanged.

Loyalty settings, balances and local ledger rows carry `group_id` and
`cache_terminal_id`. Queries keep the organization predicate and add both cache
predicates. Balance customer/profile uniqueness and phone/card indexes include
the group and terminal. Snapshot fences include the group and refuse replacement
while an active-scope queue still owns a pending earn or release.

## Migration and pending work

Migration 109 is one immediate transaction. It moves old JSON blobs without
changing their contents, rebuilds the balance table without changing IDs or
balances, and adds separate `shared_queue_scope` and
`shared_legacy_queue_scope` ownership metadata. It leaves every queue payload,
status, attempt count, claim generation, retry time and idempotency key intact.
Pending financial records are not removed.

Org-as-group work from the same original organization/store/terminal can adopt
that store's first trusted group. A real group-to-group change holds the original
shared queue row before claiming it, without spending an attempt or sending it
through another group's terminal. Terminal rebinds retain original shared queue
rows; explicit diagnostic reset behavior remains separate. Old read blobs and
loyalty caches are swept only when their pending originals no longer need them.
Pending ledger rows and queued release evidence remain.

The first org-to-group bootstrap also carries ID-only customer replay aliases in
`customer_replay_aliases_v1`; phones, names and addresses are not copied to the
new directory. Full pulls preserve aliases and pending customer/address edits.
Privacy tombstones erase the replay-alias copy as well as the directory entry.

The customer directory uses terminal-authenticated APIs, including pagination;
the previous org-wide direct Supabase pull has been removed. In-flight directory,
settings, staff and snapshot answers are fenced against a changed scope. Realtime
uses store filters for orders, organization subscriptions with group checks for
shared entities, and invalidates through scoped pulls. A group-only identity
change tears down and recreates subscriptions. Open directory pages discard old
in-memory rows and fence late responses. Caller ID uses the native group directory;
line licensing and delivery remain store owned. Platform-order identity is not
changed.

Both tills must ship together before enabling additional groups. Android owns its
own corresponding database/cache/vault/realtime migration; desktop tests do not
establish Android parity. Native device checks still need real Windows Credential
Manager, offline re-registration, interrupted replay and terminal JWT realtime.
