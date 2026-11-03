import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_THRESHOLD_PX, installScrollRows, updateScrollRowFades } from '../scroll-rows';

// Founder 01/11: sideways rows fade at an edge with more to show and follow a mouse drag; a drag never presses
// the item it started on.
const pointer = (target: Element, type: string, init: { clientX?: number; pointerType?: string; button?: number } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 });
  Object.defineProperty(event, 'button', { value: init.button ?? 0 });
  target.dispatchEvent(event);
  return event;
};

/** jsdom has no layout: give the row a scroll size by hand. */
const sizeRow = (row: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: clientWidth });
};

describe('scroll rows', () => {
  let uninstall: () => void;
  let row: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div class="pos-scroll-row" id="row"><button id="ana">Ana</button><button id="clara">Clara</button></div>`;
    row = document.getElementById('row')!;
    sizeRow(row, 900, 300);
    uninstall = installScrollRows(document);
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it('fades only the edges that have more to show', () => {
    row.scrollLeft = 0;
    updateScrollRowFades(row);
    expect(row.dataset.fadeStart).toBe('off');
    expect(row.dataset.fadeEnd).toBe('on');

    row.scrollLeft = 300;
    row.dispatchEvent(new Event('scroll'));
    expect(row.dataset.fadeStart).toBe('on');
    expect(row.dataset.fadeEnd).toBe('on');

    row.scrollLeft = 600;
    row.dispatchEvent(new Event('scroll'));
    expect(row.dataset.fadeStart).toBe('on');
    expect(row.dataset.fadeEnd).toBe('off');
  });

  it('a row that fits shows every item in full', () => {
    sizeRow(row, 300, 300);
    updateScrollRowFades(row);
    expect(row.dataset.fadeStart).toBe('off');
    expect(row.dataset.fadeEnd).toBe('off');
  });

  it('marks a row that appears later', async () => {
    const late = document.createElement('div');
    late.className = 'pos-scroll-row';
    sizeRow(late, 500, 200);
    document.body.appendChild(late);
    await Promise.resolve();
    expect(late.dataset.fadeEnd).toBe('on');
  });

  it('follows a mouse drag and swallows the click that ends it', () => {
    const ana = document.getElementById('ana')!;
    const onClick = vi.fn();
    ana.addEventListener('click', onClick);
    row.scrollLeft = 100;

    pointer(ana, 'pointerdown', { clientX: 200 });
    pointer(ana, 'pointermove', { clientX: 140 });
    expect(row.scrollLeft).toBe(160);
    expect(row.hasAttribute('data-dragging')).toBe(true);
    pointer(ana, 'pointerup', { clientX: 140 });
    expect(row.hasAttribute('data-dragging')).toBe(false);

    ana.click();
    expect(onClick).not.toHaveBeenCalled();
    // The next, real tap goes through.
    ana.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a shaky click under the threshold still clicks and does not move the row', () => {
    const clara = document.getElementById('clara')!;
    const onClick = vi.fn();
    clara.addEventListener('click', onClick);
    row.scrollLeft = 50;

    pointer(clara, 'pointerdown', { clientX: 200 });
    pointer(clara, 'pointermove', { clientX: 200 - (DRAG_THRESHOLD_PX - 1) });
    pointer(clara, 'pointerup', { clientX: 200 - (DRAG_THRESHOLD_PX - 1) });
    clara.click();

    expect(row.scrollLeft).toBe(50);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('leaves touch to the native pan', () => {
    row.scrollLeft = 0;
    pointer(row, 'pointerdown', { clientX: 200, pointerType: 'touch' });
    pointer(row, 'pointermove', { clientX: 100, pointerType: 'touch' });
    expect(row.scrollLeft).toBe(0);
    expect(row.hasAttribute('data-dragging')).toBe(false);
  });

  it('stops listening once uninstalled', () => {
    uninstall();
    row.scrollLeft = 0;
    pointer(row, 'pointerdown', { clientX: 200 });
    pointer(row, 'pointermove', { clientX: 100 });
    expect(row.scrollLeft).toBe(0);
    uninstall = () => {};
  });
});
