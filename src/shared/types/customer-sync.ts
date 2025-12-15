/**
 * Customer Sync Types (POS-local stub)
 */

export interface ConflictResult {
  isConflict: true;
  conflictId: string;
  localVersion: number;
  remoteVersion: number;
  localData: any;
  remoteData: any;
  conflictType: string;
  message?: string;
}

export interface SyncResult<T> {
  success: boolean;
  data?: T;
  conflict?: ConflictResult;
  error?: string;
}

/**
 * Type guard to check if a result is a conflict
 */
export function isConflictResult(result: any): result is ConflictResult {
  return result && typeof result === 'object' && result.isConflict === true;
}
