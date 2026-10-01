/** A version is reusable only for a complete, stable, scope-matched snapshot. */
export interface Snapshot<T> { scope: string; version: string | null; value: T }
export class SnapshotAccessError extends Error {}
export class VersionedSnapshot<T> {
  private current: Snapshot<T> | null = null;
  private inFlight: Promise<T> | null = null;
  private generation = 0;
  private scope = '';
  constructor(private readonly deps: {
    version(): Promise<string | null>;
    fetch(): Promise<T>;
    load(scope: string): Snapshot<T> | null;
    save(snapshot: Snapshot<T> | null): void;
  }) {}
  reset(scope = ''): void {
    this.generation++;
    this.scope = scope;
    this.inFlight = null;
    this.current = scope ? this.deps.load(scope) : null;
    if (this.current?.scope !== scope) this.current = null;
  }
  cached(scope: string): T | null {
    if (scope !== this.scope) this.reset(scope);
    return this.current?.value ?? null;
  }
  read(scope: string, force = false): Promise<T> {
    if (!scope) return Promise.reject(new Error('Snapshot identity missing'));
    if (scope !== this.scope) this.reset(scope);
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const checkScope = () => { if (generation !== this.generation) throw new Error('Snapshot identity changed'); };
    const run = async () => {
      try {
        const before = await this.deps.version();
        checkScope();
        if (!force && before !== null && this.current?.version === before) return this.current.value;
        const value = await this.deps.fetch();
        const after = await this.deps.version();
        checkScope();
        // Never replace a good snapshot with pages from different server revisions.
        if (before !== null && before !== after) throw new Error('Snapshot revision could not be confirmed after download');
        const snapshot = { scope, value, version: before !== null && before === after ? after : null };
        this.deps.save(snapshot);
        this.current = snapshot;
        return value;
      } catch (error) {
        checkScope();
        if (error instanceof SnapshotAccessError) { this.revoke(); throw error; }
        // Failed pages/versions do not advance the marker or replace usable data.
        if (this.current) return this.current.value;
        throw error;
      }
    };
    const promise = run().finally(() => { if (this.inFlight === promise) this.inFlight = null; });
    this.inFlight = promise;
    return promise;
  }
  revoke(): void { this.reset(); this.deps.save(null); }
}

export async function fetchAllPages<T>(read: (offset: number) => Promise<{ rows: T[]; pagination: { hasMore: boolean; nextOffset: number | null } }>): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await read(offset);
    rows.push(...page.rows);
    if (page.pagination.hasMore === false) return rows;
    const next = page.pagination.nextOffset;
    if (!page.rows.length || !Number.isInteger(next) || next! <= offset) throw new Error('Invalid snapshot pagination');
    offset = next!;
  }
}
