/**
 * Which page the main layout (RefactoredMainLayout) is showing, for listeners
 * mounted at the App level, outside every route (the incoming-order alert).
 *
 * The layout sets it before paint whenever its view changes and clears it
 * (null) when it unmounts: the /new-order route renders NewOrderPage without
 * the layout, so null there means "no layout page is on screen".
 */
import { useSyncExternalStore } from 'react';

let currentView: string | null = null;
const listeners = new Set<() => void>();

export function setPosLayoutView(view: string | null): void {
  if (currentView === view) return;
  currentView = view;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[posLayoutView] listener failed', error);
    }
  }
}

export function getPosLayoutView(): string | null {
  return currentView;
}

export function subscribePosLayoutView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePosLayoutView(): string | null {
  return useSyncExternalStore(subscribePosLayoutView, getPosLayoutView, getPosLayoutView);
}
