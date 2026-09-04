export function assertSupportedKeyringVersion(lockSource: string): void;

export function parseManagedCredentialKeys(source: string): string[];

export function renderManagedCredentialInclude(keys: readonly string[]): string;

export function renderCredentialDeleteHelper(): string;

export function generatedTextMatches(actual: string, expected: string): boolean;
