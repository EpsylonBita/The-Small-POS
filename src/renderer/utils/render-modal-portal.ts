import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Mount modal/overlay content at the document body so its full-screen backdrop/blur
 * covers the entire POS shell (sidebar + content) instead of being clipped by a
 * transformed/overflow ancestor in the page container. Mirrors the founder rule that
 * every modal opens outside the container and blurs the rest of the screen.
 *
 * SSR / no-document environments fall back to inline rendering so nothing throws.
 */
export function renderModalPortal(node: ReactNode): ReactNode {
  if (typeof document === 'undefined' || !document.body) {
    return node;
  }
  return createPortal(node, document.body);
}
