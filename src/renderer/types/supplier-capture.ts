/**
 * Desktop re-export of the shared invoice-capture contracts.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — "Shared types".
 * The authoritative definitions live in the repository root at
 * `shared/types/supplier-capture.ts`, alongside the server routes and the
 * mobile mirror that consume the same wire shapes.
 *
 * This file exists so capture screens at different depths under
 * `src/renderer/` all say `from '../types/supplier-capture'` instead of each
 * counting its own `../../../../` prefix — the same reason
 * `src/renderer/types/tables.ts` re-exports the canonical `TableStatus`.
 * It adds nothing and narrows nothing; changing a capture contract means
 * changing the root file (and its mobile mirror), never this one.
 */

export type {
  CaptureCommitRequestExtras,
  CaptureOrigin,
  CaptureOutcomeCode,
  CaptureRecognitionPage,
  CaptureSourceConfig,
  CaptureSourceKind,
  CaptureStatus,
  ConfidenceTier,
} from '../../../../shared/types/supplier-capture';

export { captureOutcomeCodes } from '../../../../shared/types/supplier-capture';
