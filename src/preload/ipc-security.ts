/**
 * IPC security stub for Tauri.
 * In Electron, this module validates channel names in the preload script.
 * In Tauri, security is handled by the Tauri command permission system,
 * so this is a passthrough stub.
 */

export function isAllowedChannel(channel: string): boolean {
  return true;
}

export function sanitizeArgs(args: any[]): any[] {
  return args;
}

export function filterAllowedInvokes(channels: string[]): string[] {
  return channels;
}
