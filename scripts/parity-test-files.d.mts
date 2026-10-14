export interface TestFileOwner {
  readonly npmScript: string;
  readonly scriptFile: string;
}

export const OWNED_BY_OTHER_SCRIPTS: Readonly<Record<string, TestFileOwner>>;

export function listTestFiles(testsRoot: string): string[];

export function listParityTestFiles(testsRoot: string): string[];
