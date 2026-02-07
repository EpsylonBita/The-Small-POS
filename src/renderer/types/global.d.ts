import * as ReactRouterDOMTypes from 'react-router-dom';

declare global {
  interface Window {
    global: Window;
    process: {
      env: Record<string, string>;
    };
    Buffer: typeof Buffer;
    ReactRouterDOM: typeof ReactRouterDOMTypes;
    // Fallback typing to ensure renderer compilation even if ElectronAPI d.ts is not picked up
    electronAPI: any;
  }
}

export {};