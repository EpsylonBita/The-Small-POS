/** One read owner per POS. Consumers and local projection never create readers. */
export class KdsReadCoordinator {
  private scope = '';
  private active = false;
  private generation = 0;
  private running: Promise<void> | null = null;
  private queued: ((isCurrent: () => boolean) => Promise<void>) | null = null;

  configure(scope: string, active: boolean): void {
    if (scope === this.scope && active === this.active) return;
    this.scope = scope;
    this.active = active && Boolean(scope);
    this.generation += 1;
    this.queued = null;
  }

  request(read: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.running) {
      this.queued = read;
      return this.running;
    }
    const run = async () => {
      let next: typeof read | null = read;
      while (next && this.active) {
        const generation = this.generation;
        await next(() => this.active && generation === this.generation);
        next = this.queued;
        this.queued = null;
      }
    };
    this.running = run().finally(() => { this.running = null; });
    return this.running;
  }
}
