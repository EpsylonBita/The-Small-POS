/**
 * Sideways rows (founder 01/11/2026: «κάνε αυτή την μπάρα να σέρνεται δεξιά αριστερά αλλά να χάνονται χωρίς να
 * κόβεται έτσι δεξιά και αριστερά»).
 *
 * Every `.pos-scroll-row` (styles/glassmorphism.css) fades its items out at an edge that has more to show, and a
 * mouse can drag it sideways; a finger already pans it natively. This marks each row with
 * `data-fade-start` / `data-fade-end` ('on' | 'off') as it scrolls, resizes or appears, and while a mouse drags it,
 * `data-dragging`. A drag never presses the item it started on: the click that ends it is swallowed. A plain click
 * (moved less than DRAG_THRESHOLD_PX) reaches the item as before.
 */
export const SCROLL_ROW_SELECTOR = '.pos-scroll-row';

/** A mouse must move this far before the row follows it, so a slightly shaky click still clicks. */
export const DRAG_THRESHOLD_PX = 6;

/** Sets the fade marks of one row from its scroll position (a pixel of slack for fractional widths). */
export function updateScrollRowFades(row: HTMLElement): void {
  const max = row.scrollWidth - row.clientWidth;
  const start = row.scrollLeft > 1 ? 'on' : 'off';
  const end = max - row.scrollLeft > 1 ? 'on' : 'off';
  if (row.dataset.fadeStart !== start) row.dataset.fadeStart = start;
  if (row.dataset.fadeEnd !== end) row.dataset.fadeEnd = end;
}

export function installScrollRows(doc: Document = document): () => void {
  const view = doc.defaultView;
  const resizeObserver = view && 'ResizeObserver' in view
    ? new view.ResizeObserver((entries) => {
        for (const entry of entries) updateScrollRowFades(entry.target as HTMLElement);
      })
    : null;
  const watched = new WeakSet<Element>();

  const watch = (root: ParentNode) => {
    const rows: Element[] = [];
    if (root instanceof Element && root.matches(SCROLL_ROW_SELECTOR)) rows.push(root);
    rows.push(...root.querySelectorAll(SCROLL_ROW_SELECTOR));
    for (const row of rows) {
      updateScrollRowFades(row as HTMLElement);
      if (watched.has(row)) continue;
      watched.add(row);
      resizeObserver?.observe(row);
      // The items inside change size too (a font loads, a label grows).
      for (const child of row.children) resizeObserver?.observe(child);
    }
  };

  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && target.matches(SCROLL_ROW_SELECTOR)) updateScrollRowFades(target as HTMLElement);
  };

  const mutationObserver = view && 'MutationObserver' in view
    ? new view.MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof Element) watch(node);
          if (record.target instanceof Element) {
            const row = record.target.closest(SCROLL_ROW_SELECTOR);
            if (row) watch(row);
          }
        }
      })
    : null;

  // Mouse drag. Touch and pen pan the row natively (touch-action: pan-x), so only a mouse is handled here.
  let drag: { row: HTMLElement; startX: number; startLeft: number; moved: boolean } | null = null;
  let swallowClick = false;

  const onPointerDown = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType !== 'mouse' || pointer.button !== 0) return;
    const row = event.target instanceof Element ? event.target.closest(SCROLL_ROW_SELECTOR) : null;
    if (!(row instanceof HTMLElement) || row.scrollWidth <= row.clientWidth) return;
    drag = { row, startX: pointer.clientX, startLeft: row.scrollLeft, moved: false };
  };

  const onPointerMove = (event: Event) => {
    if (!drag) return;
    const dx = (event as PointerEvent).clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      drag.row.dataset.dragging = '';
    }
    drag.row.scrollLeft = drag.startLeft - dx;
  };

  const onPointerEnd = () => {
    if (!drag) return;
    if (drag.moved) {
      delete drag.row.dataset.dragging;
      swallowClick = true;
      // A drag that ends outside any item fires no click; never let the flag outlive this release.
      view?.setTimeout(() => { swallowClick = false; }, 0);
    }
    drag = null;
  };

  const onClick = (event: Event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.addEventListener('pointerup', onPointerEnd, { capture: true, passive: true });
  doc.addEventListener('pointercancel', onPointerEnd, { capture: true, passive: true });
  doc.addEventListener('click', onClick, { capture: true });
  if (doc.body) {
    watch(doc.body);
    mutationObserver?.observe(doc.body, { childList: true, subtree: true });
  }

  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true });
    doc.removeEventListener('pointermove', onPointerMove, { capture: true });
    doc.removeEventListener('pointerup', onPointerEnd, { capture: true });
    doc.removeEventListener('pointercancel', onPointerEnd, { capture: true });
    doc.removeEventListener('click', onClick, { capture: true });
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
  };
}
