import * as ReactRouterDOMTypes from 'react-router-dom';

declare global {
  interface Window {
    global: Window;
    process: {
      env: Record<string, string>;
    };
    Buffer: typeof Buffer;
    ReactRouterDOM: typeof ReactRouterDOMTypes;
  }
}

export {};
