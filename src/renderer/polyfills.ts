// Polyfills for both Electron and Web environments
// This ensures the POS system works in both contexts

// Detect if we're in Electron or Web browser
const isElectron = typeof window !== 'undefined' &&
  window.process &&
  (window.process as any).type === 'renderer';
const isWeb = typeof window !== 'undefined' && !isElectron;

// Global polyfills for web environment
if (isWeb) {
  // Polyfill for global
  if (typeof global === 'undefined') {
    (window as any).global = window;
  }

  // Polyfill for process
  if (typeof process === 'undefined') {
    (window as any).process = {
      env: {
        NODE_ENV: 'production'
      },
      platform: 'browser',
      version: 'v16.0.0',
      versions: { node: '16.0.0' },
      browser: true,
      type: 'renderer'
    };
  }

  // Polyfill for require (basic implementation)
  if (typeof require === 'undefined') {
    (window as any).require = function(module: string) {
      // Basic require polyfill for common modules
      switch (module) {
        case 'path':
          return {
            join: (...args: string[]) => args.join('/').replace(/\/+/g, '/'),
            resolve: (...args: string[]) => args.join('/').replace(/\/+/g, '/'),
            dirname: (path: string) => path.split('/').slice(0, -1).join('/') || '/',
            basename: (path: string) => path.split('/').pop() || '',
            extname: (path: string) => {
              const name = path.split('/').pop() || '';
              const lastDot = name.lastIndexOf('.');
              return lastDot > 0 ? name.substring(lastDot) : '';
            }
          };
        case 'os':
          return {
            platform: () => 'browser',
            type: () => 'Browser',
            arch: () => 'x64',
            release: () => '1.0.0',
            homedir: () => '/',
            tmpdir: () => '/tmp'
          };
        case 'fs':
          return {
            readFileSync: () => { throw new Error('fs.readFileSync not available in browser'); },
            writeFileSync: () => { throw new Error('fs.writeFileSync not available in browser'); },
            existsSync: () => false
          };
        case 'crypto':
          return window.crypto || {};
        case 'util':
          return {
            inspect: (obj: any) => JSON.stringify(obj, null, 2),
            format: (f: string, ...args: any[]) => f.replace(/%s/g, () => args.shift() || ''),
            isBuffer: (obj: any) => obj instanceof ArrayBuffer
          };
        default:
          console.warn(`Module '${module}' not found in require polyfill`);
          return {};
      }
    };
  }

  // Buffer polyfill - simple implementation to avoid circular dependency
  if (typeof Buffer === 'undefined') {
    (window as any).Buffer = {
      from: (data: any) => {
        if (typeof data === 'string') {
          return new TextEncoder().encode(data);
        }
        return new Uint8Array(data);
      },
      alloc: (size: number) => new Uint8Array(size),
      isBuffer: (obj: any) => obj instanceof Uint8Array,
      concat: (list: any[]) => {
        const totalLength = list.reduce((sum, buf) => sum + buf.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of list) {
          result.set(buf, offset);
          offset += buf.length;
        }
        return result;
      }
    };
  }
}

// Console polyfills (for both environments)
if (typeof console === 'undefined') {
  (window as any).console = {
    log: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  };
}

// Export environment detection utilities
export const environment = {
  isElectron,
  isWeb,
  isBrowser: isWeb,
  isDesktop: isElectron
};

// Export empty to make TypeScript happy
export {}; 