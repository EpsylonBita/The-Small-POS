/**
 * ASAR Integrity Verification
 *
 * SECURITY: Detects post-installation tampering of application code
 * Prevents attacks where attacker modifies ASAR archive to inject backdoors
 *
 * How it works:
 * 1. At build time, generate SHA-256 checksum of ASAR
 * 2. At runtime, recalculate checksum and compare
 * 3. If mismatch, refuse to start (application has been tampered with)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { app } from 'electron';
import * as path from 'path';

// IMPORTANT: This checksum is generated at build time
// See scripts/generate-asar-checksum.js
// For development (non-ASAR), this check is skipped
const EXPECTED_CHECKSUM = process.env.ASAR_CHECKSUM || 'DEVELOPMENT_MODE';

export interface IntegrityCheckResult {
  valid: boolean;
  isASAR: boolean;
  expectedChecksum: string;
  actualChecksum?: string;
  error?: string;
}

/**
 * Verify ASAR integrity
 * Returns true if valid or not in ASAR mode (development)
 */
export function verifyASARIntegrity(): IntegrityCheckResult {
  try {
    const appPath = app.getAppPath();

    // Check if running from ASAR
    const isASAR = appPath.includes('.asar');

    if (!isASAR) {
      console.log('[ASAR Integrity] Running in development mode (not packed) - skipping integrity check');
      return {
        valid: true,
        isASAR: false,
        expectedChecksum: 'N/A (development)',
      };
    }

    // In production, verify ASAR integrity
    console.log('[ASAR Integrity] Verifying application integrity...');

    if (EXPECTED_CHECKSUM === 'DEVELOPMENT_MODE') {
      console.warn('[ASAR Integrity] WARNING: ASAR checksum not configured!');
      console.warn('[ASAR Integrity] Set ASAR_CHECKSUM environment variable during build');
      return {
        valid: true, // Allow for now, but log warning
        isASAR: true,
        expectedChecksum: 'NOT_CONFIGURED',
        error: 'Checksum not configured - integrity cannot be verified',
      };
    }

    // Find ASAR file
    // appPath might be /path/to/app.asar or /path/to/app.asar/some/file
    const asarPath = appPath.split('.asar')[0] + '.asar';

    if (!fs.existsSync(asarPath)) {
      console.error('[ASAR Integrity] ASAR file not found:', asarPath);
      return {
        valid: false,
        isASAR: true,
        expectedChecksum: EXPECTED_CHECKSUM,
        error: 'ASAR file not found',
      };
    }

    // Calculate actual checksum
    const actualChecksum = calculateFileChecksum(asarPath);

    if (actualChecksum !== EXPECTED_CHECKSUM) {
      console.error('[ASAR Integrity] ❌ INTEGRITY CHECK FAILED!');
      console.error('[ASAR Integrity] Expected:', EXPECTED_CHECKSUM);
      console.error('[ASAR Integrity] Actual:  ', actualChecksum);
      console.error('[ASAR Integrity] Application has been tampered with!');

      return {
        valid: false,
        isASAR: true,
        expectedChecksum: EXPECTED_CHECKSUM,
        actualChecksum: actualChecksum,
        error: 'Checksum mismatch - application has been tampered with',
      };
    }

    console.log('[ASAR Integrity] ✅ Integrity check passed');
    return {
      valid: true,
      isASAR: true,
      expectedChecksum: EXPECTED_CHECKSUM,
      actualChecksum: actualChecksum,
    };
  } catch (error) {
    console.error('[ASAR Integrity] Error during integrity check:', error);
    return {
      valid: false,
      isASAR: false,
      expectedChecksum: EXPECTED_CHECKSUM,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Calculate SHA-256 checksum of a file
 */
function calculateFileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generate checksum for ASAR file (used at build time)
 * Usage: node -e "require('./dist/main/lib/asar-integrity').generateASARChecksum()"
 */
export function generateASARChecksum(asarPath?: string): string | null {
  try {
    // If path not provided, try to find ASAR in common locations
    if (!asarPath) {
      const possiblePaths = [
        path.join(process.cwd(), 'release', 'win-unpacked', 'resources', 'app.asar'),
        path.join(process.cwd(), 'release', 'mac', 'The Small POS.app', 'Contents', 'Resources', 'app.asar'),
        path.join(process.cwd(), 'dist', 'app.asar'),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          asarPath = p;
          break;
        }
      }
    }

    if (!asarPath || !fs.existsSync(asarPath)) {
      console.error('[ASAR Checksum] ASAR file not found');
      return null;
    }

    const checksum = calculateFileChecksum(asarPath);
    console.log('[ASAR Checksum] Generated checksum for:', asarPath);
    console.log('[ASAR Checksum]', checksum);
    console.log('[ASAR Checksum] Add to build process: ASAR_CHECKSUM=' + checksum);

    return checksum;
  } catch (error) {
    console.error('[ASAR Checksum] Error generating checksum:', error);
    return null;
  }
}
