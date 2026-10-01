import type {
  ExternalDisplayCapabilities,
  ExternalDisplayInfo,
  ExternalDisplayOpenParams,
  ExternalDisplayPresentation,
} from '../../lib';

/**
 * Renderer view of native external screen ownership. The Rust lease table
 * (`src-tauri/src/commands/system_ui/display_lease.rs`) stays authoritative:
 * each projected content holds one physical monitor, the monitor showing the
 * cashier POS is never offered (the OS primary flag is informational only), a
 * running presentation is reopened only for its current token, and every
 * successful open returns an opaque presentation token. These selectors only
 * describe the last native answer.
 */

/** The opening or running presentation of this content; a closing window no longer counts. */
export function liveExternalPresentation(
  capabilities: ExternalDisplayCapabilities | null,
  contentType: string
): ExternalDisplayPresentation | undefined {
  return capabilities?.activePresentations?.find(
    (presentation) => presentation.contentType === contentType && presentation.state !== 'closing'
  );
}

/** The content is projected or opening; a closing window no longer counts. */
export function isExternalContentLive(
  capabilities: ExternalDisplayCapabilities | null,
  contentType: string
): boolean {
  return Boolean(liveExternalPresentation(capabilities, contentType));
}

/**
 * Valid external screens only: never the one showing the cashier POS, while an
 * external TV that is the OS primary counts like any other screen. Only an explicit
 * native answer counts, so a screen of unknown topology (failed read, missing flag
 * or missing identity) is never offered.
 */
export function externalDisplayChoices(
  capabilities: ExternalDisplayCapabilities | null
): ExternalDisplayInfo[] {
  if (!capabilities?.success || !capabilities.supported) return [];
  return (capabilities.displays ?? []).filter(
    (display) =>
      display.external === true &&
      display.hostsPos === false &&
      typeof display.id === 'string' &&
      display.id !== ''
  );
}

/** No content is opening, running or closing on this screen; unknown availability is not free. */
export function isExternalDisplayFree(display: ExternalDisplayInfo): boolean {
  return display.available === true && !display.occupiedBy;
}

/**
 * An explicit screen travels only as its opaque id, never an enumeration index, so
 * the native side rejects a missing or occupied screen instead of redirecting.
 * Without a screen the native side picks the first free external one.
 * `expectedToken` names the presentation the caller holds when it asks: native
 * reopens (and rotates) a running presentation only for its current token, and an
 * open naming none only starts a content without a presentation, so a late or
 * stale open never takes over a newer one.
 */
export function externalOpenParams(
  contentType: string,
  display?: ExternalDisplayInfo | null,
  expectedToken?: string | null
): ExternalDisplayOpenParams {
  const params: ExternalDisplayOpenParams = { contentType };
  if (display) params.displayId = typeof display.id === 'string' ? display.id : '';
  if (expectedToken) params.expectedToken = expectedToken;
  return params;
}

interface ExternalDisplayCloser<T> {
  externalDisplay: { close(params: { contentType: string; token?: string }): Promise<T> };
}

/**
 * The one presentation a main-window owner may close and reopen: the token of its
 * own successful open or, when it opened nothing itself, of the live presentation it
 * adopted (for example after the main window reloaded). Stop and cleanup close
 * exactly this token and opens name it as `expectedToken`, so a stale owner never
 * closes, reuses or rotates a newer session.
 */
export class ExternalPresentationOwner {
  private token: string | null = null;
  private pendingOpens = 0;
  private changes = 0;

  constructor(private readonly contentType: string) {}

  get ownedToken(): string | null {
    return this.token;
  }

  /**
   * Ownership state a capability read starts from; pass it back to `observe`. It
   * changes whenever an open starts or settles and whenever the owned token changes,
   * so the answer to an older read never changes what this owner holds.
   */
  get revision(): number {
    return this.changes;
  }

  /** Marks one native open in flight; call the returned function once it settled, stale close included. */
  beginOpen(): () => void {
    this.pendingOpens += 1;
    this.changes += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.pendingOpens = Math.max(0, this.pendingOpens - 1);
      this.changes += 1;
    };
  }

  /** A successful open owns its fresh token; reopening the running content rotated it. */
  opened(result: { success?: boolean; token?: string } | null | undefined): void {
    if (result?.success && result.token) this.hold(result.token);
  }

  /**
   * Follows a native capability answer, never while an open is in flight and never
   * from a failed or unknown read. Owning nothing, it adopts the live presentation of
   * this content. Owning one, it forgets it only when the answer to a read issued at
   * the current `revision` lists no presentation of this content at all (for example
   * after the OS closed the window), so the next open starts fresh. It never swaps
   * its token for another one. Without a revision (a cached answer) it only adopts.
   */
  observe(capabilities: ExternalDisplayCapabilities | null, revision?: number): void {
    if (this.pendingOpens > 0) return;
    if (revision !== undefined && revision !== this.changes) return;
    if (!capabilities?.success || !capabilities.supported) return;
    const presentations = capabilities.activePresentations;
    if (!Array.isArray(presentations)) return;
    if (this.token) {
      const leased = presentations.some((presentation) => presentation.contentType === this.contentType);
      if (revision !== undefined && !leased) this.hold(null);
      return;
    }
    const live = liveExternalPresentation(capabilities, this.contentType);
    if (live?.token) this.hold(live.token);
  }

  /** Ends ownership and closes only the owned presentation: nothing owned, nothing closed. */
  async release<T>(bridge: ExternalDisplayCloser<T>): Promise<T | null> {
    const token = this.token;
    this.hold(null);
    if (!token) return null;
    return bridge.externalDisplay.close({ contentType: this.contentType, token });
  }

  private hold(token: string | null): void {
    this.token = token;
    this.changes += 1;
  }
}

/**
 * A late open completion of a previous owner closes only the presentation it
 * created. Its token no longer matches once a newer owner opened the content,
 * so it can never close that newer projection. A failed open left nothing open.
 */
export async function closeStaleExternalOpen(
  bridge: ExternalDisplayCloser<unknown>,
  contentType: string,
  result: { success?: boolean; token?: string } | null | undefined
): Promise<void> {
  if (result?.success && result.token) {
    await bridge.externalDisplay.close({ contentType, token: result.token });
  }
}
