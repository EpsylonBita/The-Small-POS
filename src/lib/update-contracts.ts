export interface UpdateReleaseNote {
  version: string;
  note?: string;
}

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | UpdateReleaseNote[];
}

export interface ProgressInfo {
  bytesPerSecond: number;
  delta: number;
  percent: number;
  total: number;
  transferred: number;
}
