/**
 * Electron type stubs for Tauri build compatibility.
 * These provide just enough type surface for the copied Electron POS renderer
 * to compile without the real Electron dependency.
 */

declare module 'electron' {
  export interface IpcRendererEvent {
    sender: unknown;
    senderId: number;
  }

  export interface IpcRenderer {
    invoke(channel: string, ...args: any[]): Promise<any>;
    send(channel: string, ...args: any[]): void;
    on(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): this;
    once(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): this;
    removeListener(channel: string, listener: (...args: any[]) => void): this;
    removeAllListeners(channel: string): this;
  }

  export interface BrowserWindow {
    webContents: { send(channel: string, ...args: any[]): void };
    isMaximized(): boolean;
    isFullScreen(): boolean;
    isDestroyed(): boolean;
  }

  export interface Clipboard {
    readText(): string;
    writeText(text: string): void;
  }

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: any): void;
  };

  export const ipcRenderer: IpcRenderer;
  export const clipboard: Clipboard;
}

declare module 'electron-updater' {
  export interface ReleaseNoteInfo {
    version: string;
    note?: string;
  }

  export interface UpdateInfo {
    version: string;
    releaseDate: string;
    releaseName?: string;
    releaseNotes?: string | ReleaseNoteInfo[];
    files: Array<{ url: string; sha512: string; size: number }>;
  }

  export interface ProgressInfo {
    total: number;
    delta: number;
    transferred: number;
    percent: number;
    bytesPerSecond: number;
  }
}
