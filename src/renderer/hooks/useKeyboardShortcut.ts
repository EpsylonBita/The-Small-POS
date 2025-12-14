import { useEffect } from 'react';

type KeyCombo = string | string[];

interface UseKeyboardShortcutOptions {
    enabled?: boolean;
    preventDefault?: boolean;
    ignoreOnInputFocus?: boolean;
}

export const useKeyboardShortcut = (
    keyCombo: KeyCombo,
    callback: (e: KeyboardEvent) => void,
    options: UseKeyboardShortcutOptions = {}
) => {
    const {
        enabled = true,
        preventDefault = true,
        ignoreOnInputFocus = true
    } = options;

    useEffect(() => {
        if (!enabled) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            // Check if focus is on an input/textarea/select
            if (ignoreOnInputFocus) {
                const target = event.target as HTMLElement;
                const isInput =
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.tagName === 'SELECT' ||
                    target.isContentEditable;

                if (isInput) return;
            }

            const keys = Array.isArray(keyCombo) ? keyCombo : [keyCombo];
            const pressedKey = event.key.toLowerCase();

            const match = keys.some(key => {
                const parts = key.toLowerCase().split('+');
                const mainKey = parts[parts.length - 1];

                const ctrl = parts.includes('ctrl') || parts.includes('control');
                const shift = parts.includes('shift');
                const alt = parts.includes('alt');
                const meta = parts.includes('meta') || parts.includes('cmd');

                if (ctrl && !event.ctrlKey) return false;
                if (shift && !event.shiftKey) return false;
                if (alt && !event.altKey) return false;
                if (meta && !event.metaKey) return false;

                return mainKey === pressedKey;
            });

            if (match) {
                if (preventDefault) {
                    event.preventDefault();
                }
                callback(event);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [keyCombo, callback, enabled, preventDefault, ignoreOnInputFocus]);
};
