import * as bcrypt from 'bcryptjs';
import { DatabaseManager, StaffSession } from './database';
import { BrowserWindow } from 'electron';
import { SettingsService } from './services/SettingsService';

// Security constants
const BCRYPT_ROUNDS = 10;
const MIN_PIN_LENGTH = 6;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export interface AuthResult {
  success: boolean;
  sessionId?: string;
  role?: 'admin' | 'staff';
  staffId?: string;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  staffId: string;
  role: 'admin' | 'staff';
  loginTime: string;
  isActive: boolean;
}

export class AuthService {
  private dbManager: DatabaseManager;
  private settingsService: SettingsService;
  private mainWindow: BrowserWindow | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;
  private readonly SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
  private readonly INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
  private lastActivity: number = Date.now();

  // Rate limiting for brute-force protection
  private loginAttempts: Map<string, { count: number; lockedUntil?: number }> = new Map();

  constructor(dbManager: DatabaseManager, settingsService: SettingsService) {
    this.dbManager = dbManager;
    this.settingsService = settingsService;
    this.setupInactivityMonitoring();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  private setupInactivityMonitoring(): void {
    // Check for inactivity every minute
    setInterval(() => {
      this.checkInactivity();
    }, 60000);
  }

  private async checkInactivity(): Promise<void> {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivity;

    if (timeSinceLastActivity > this.INACTIVITY_TIMEOUT) {
      const activeSession = await this.dbManager.getActiveSession();
      if (activeSession) {
        await this.logout();
        this.notifyRenderer('session-timeout', { reason: 'inactivity' });
      }
    }
  }

  updateActivity(): void {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  private async hashPin(pin: string): Promise<string> {
    return bcrypt.hash(pin, BCRYPT_ROUNDS);
  }

  private async verifyPin(pin: string, hashedPin: string): Promise<boolean> {
    return bcrypt.compare(pin, hashedPin);
  }

  private checkRateLimit(key: string): { allowed: boolean; error?: string } {
    const attempts = this.loginAttempts.get(key);
    const now = Date.now();

    if (attempts?.lockedUntil && attempts.lockedUntil > now) {
      const remainingMinutes = Math.ceil((attempts.lockedUntil - now) / 60000);
      return { allowed: false, error: `Account locked. Try again in ${remainingMinutes} minutes.` };
    }

    if (attempts?.lockedUntil && attempts.lockedUntil <= now) {
      this.loginAttempts.delete(key);
    }

    return { allowed: true };
  }

  private recordFailedAttempt(key: string): void {
    const attempts = this.loginAttempts.get(key) || { count: 0 };
    attempts.count++;

    if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
      attempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      console.warn(`[AuthService] Account ${key} locked after ${MAX_LOGIN_ATTEMPTS} failed attempts`);
    }

    this.loginAttempts.set(key, attempts);
  }

  private clearFailedAttempts(key: string): void {
    this.loginAttempts.delete(key);
  }

  async login(pin: string, staffId?: string): Promise<AuthResult> {
    console.log('[AuthService] ========== LOGIN START ==========');
    console.log('[AuthService] PIN received:', pin === '' ? '(empty string)' : `(${pin.length} chars)`);
    console.log('[AuthService] staffId received:', staffId || '(none)');

    const rateLimitKey = staffId || 'default';

    // Check rate limiting
    const rateCheck = this.checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      console.log('[AuthService] Rate limited:', rateCheck.error);
      return { success: false, error: rateCheck.error };
    }

    try {
      // Get configured PINs from settings (hashed)
      const adminPinHash = this.settingsService.getSetting<string>('staff', 'admin_pin_hash', '');
      const staffPinHash = this.settingsService.getSetting<string>('staff', 'staff_pin_hash', '');
      const noPinConfigured = !adminPinHash && !staffPinHash;

      console.log('[AuthService] adminPinHash configured:', !!adminPinHash);
      console.log('[AuthService] staffPinHash configured:', !!staffPinHash);
      console.log('[AuthService] noPinConfigured:', noPinConfigured);

      // If no PINs configured, require setup
      if (noPinConfigured) {
        console.log('[AuthService] No PINs configured - setup required');
        return {
          success: false,
          error: 'PIN setup required. Please configure admin and staff PINs in settings.'
        };
      }

      // Validate PIN format
      if (!pin || pin.length < MIN_PIN_LENGTH || !/^\d+$/.test(pin)) {
        console.log('[AuthService] PIN format validation FAILED');
        this.recordFailedAttempt(rateLimitKey);
        return {
          success: false,
          error: `PIN must be at least ${MIN_PIN_LENGTH} digits`
        };
      }

      // Check if there's already an active session
      const existingSession = await this.dbManager.getActiveSession();
      if (existingSession) {
        console.log('[AuthService] Found existing session, attempting to clean it up:', existingSession.id);
        // Try to end the stale session before rejecting
        try {
          await this.dbManager.endSession(existingSession.id);
          console.log('[AuthService] Successfully ended stale session');
        } catch (e) {
          console.error('[AuthService] Failed to end stale session:', e);
          return {
            success: false,
            error: 'Another user is already logged in. Please logout first.'
          };
        }
      }

      // Determine role based on PIN verification
      console.log('[AuthService] Determining role by verifying PIN hash');
      let role: 'admin' | 'staff';
      let resolvedStaffId: string;

      if (adminPinHash && await this.verifyPin(pin, adminPinHash)) {
        console.log('[AuthService] Matched admin PIN -> admin role');
        role = 'admin';
        resolvedStaffId = staffId || 'admin';
        this.clearFailedAttempts(rateLimitKey);
      } else if (staffPinHash && await this.verifyPin(pin, staffPinHash)) {
        console.log('[AuthService] Matched staff PIN -> staff role');
        role = 'staff';
        resolvedStaffId = staffId || 'staff';
        this.clearFailedAttempts(rateLimitKey);
      } else {
        console.log('[AuthService] No PIN match found - returning Invalid PIN error');
        this.recordFailedAttempt(rateLimitKey);
        return {
          success: false,
          error: 'Invalid PIN'
        };
      }

      // Use the verified hash for session storage
      const pinHash = (role === 'admin' ? adminPinHash : staffPinHash)!;
      console.log('[AuthService] Creating session for staffId:', resolvedStaffId, 'role:', role);

      // Create new session
      let session;
      try {
        session = await this.dbManager.createStaffSession(resolvedStaffId, pinHash, role);
        console.log('[AuthService] Session created successfully:', session?.id);
      } catch (sessionError) {
        console.error('[AuthService] Failed to create session:', sessionError);
        return {
          success: false,
          error: 'Failed to create session: ' + (sessionError instanceof Error ? sessionError.message : 'Unknown error')
        };
      }
      const sessionId = session.id;

      // Set session timeout
      this.setSessionTimeout();

      // Update last activity
      this.updateActivity();

      // Notify renderer about successful login
      this.notifyRenderer('login-success', {
        sessionId,
        staffId: resolvedStaffId,
        role
      });

      console.log('[AuthService] ========== LOGIN SUCCESS ==========');
      console.log('[AuthService] Returning:', { success: true, sessionId, role, staffId: resolvedStaffId });
      return {
        success: true,
        sessionId,
        role,
        staffId: resolvedStaffId
      };
    } catch (error) {
      console.error('[AuthService] ========== LOGIN ERROR ==========');
      console.error('[AuthService] Login error:', error);
      return {
        success: false,
        error: 'Login failed due to system error'
      };
    }
  }

  async logout(): Promise<boolean> {
    try {
      const activeSession = await this.dbManager.getActiveSession();

      if (!activeSession) {
        return false;
      }

      // End the session in database
      const success = await this.dbManager.endSession(activeSession.id);

      if (success) {
        // Clear session timeout
        this.clearSessionTimeout();

        // Notify renderer about logout
        this.notifyRenderer('logout-success', {
          sessionId: activeSession.id,
          staffId: activeSession.staff_id
        });
      }

      return success;
    } catch (error) {
      console.error('Logout error:', error);
      return false;
    }
  }

  async getCurrentSession(): Promise<SessionInfo | null> {
    try {
      const activeSession = await this.dbManager.getActiveSession();

      if (!activeSession) {
        return null;
      }

      // Check if session has expired
      const loginTime = new Date(activeSession.login_time).getTime();
      const now = Date.now();

      if (now - loginTime > this.SESSION_DURATION) {
        await this.logout();
        this.notifyRenderer('session-timeout', { reason: 'time-limit' });
        return null;
      }

      return {
        sessionId: activeSession.id,
        staffId: activeSession.staff_id,
        role: activeSession.role,
        loginTime: activeSession.login_time,
        isActive: activeSession.is_active
      };
    } catch (error) {
      console.error('Error getting current session:', error);
      return null;
    }
  }

  async validateSession(sessionId: string): Promise<boolean> {
    try {
      const currentSession = await this.getCurrentSession();
      return currentSession?.sessionId === sessionId;
    } catch (error) {
      console.error('Error validating session:', error);
      return false;
    }
  }

  async hasPermission(action: string): Promise<boolean> {
    try {
      const session = await this.getCurrentSession();

      if (!session) {
        return false;
      }

      // Define permissions based on role
      const permissions = {
        admin: [
          'view_orders',
          'update_order_status',
          'create_order',
          'delete_order',
          'view_reports',
          'manage_staff',
          'system_settings',
          'force_sync'
        ],
        staff: [
          'view_orders',
          'update_order_status',
          'create_order'
        ]
      };

      return permissions[session.role]?.includes(action) || false;
    } catch (error) {
      console.error('Error checking permissions:', error);
      return false;
    }
  }

  private setSessionTimeout(): void {
    this.clearSessionTimeout();

    this.sessionTimeout = setTimeout(async () => {
      await this.logout();
      this.notifyRenderer('session-timeout', { reason: 'duration-limit' });
    }, this.SESSION_DURATION);
  }

  private clearSessionTimeout(): void {
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }
  }

  private notifyRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // Method to change PIN (admin only)
  async changePin(currentPin: string, newPin: string, targetStaffId?: string): Promise<boolean> {
    try {
      const session = await this.getCurrentSession();

      if (!session || session.role !== 'admin') {
        return false;
      }

      // Validate new PIN format
      if (!/^\d{4}$/.test(newPin)) {
        return false;
      }

      // In a real implementation, you would update the PIN in a staff database
      // For now, we'll just return true
      return true;
    } catch (error) {
      console.error('Error changing PIN:', error);
      return false;
    }
  }

  // Method to get session statistics
  async getSessionStats(): Promise<any> {
    try {
      const session = await this.getCurrentSession();

      if (!session) {
        return null;
      }

      const loginTime = new Date(session.loginTime);
      const now = new Date();
      const sessionDuration = now.getTime() - loginTime.getTime();
      const remainingTime = this.SESSION_DURATION - sessionDuration;
      const timeSinceActivity = Date.now() - this.lastActivity;

      return {
        staffId: session.staffId,
        role: session.role,
        loginTime: session.loginTime,
        sessionDuration,
        remainingTime: Math.max(0, remainingTime),
        timeSinceActivity,
        inactivityWarning: timeSinceActivity > (this.INACTIVITY_TIMEOUT * 0.8) // Warning at 80% of timeout
      };
    } catch (error) {
      console.error('Error getting session stats:', error);
      return null;
    }
  }

  // Initialize auth service
  async initialize(): Promise<void> {
    try {
      // Check if terminal is properly configured
      const terminalId = this.settingsService.getSetting<string>('terminal', 'terminal_id', '');
      const isConfigured = terminalId && terminalId !== '' && terminalId !== 'terminal-001';

      // If terminal is not configured, clear ALL sessions to prevent stale sessions from blocking login
      if (!isConfigured) {
        console.log('[AuthService] Terminal not configured, clearing all sessions');
        try {
          await this.clearAllSessions();
        } catch (e) {
          console.warn('[AuthService] Failed to clear sessions:', e);
        }
        return;
      }

      // Check for any existing active sessions and clean them up
      const existingSession = await this.dbManager.getActiveSession();

      if (existingSession) {
        // Check if the session is still valid
        const loginTime = new Date(existingSession.login_time).getTime();
        const now = Date.now();

        if (now - loginTime > this.SESSION_DURATION) {
          // Session expired, clean it up
          await this.dbManager.endSession(existingSession.id);
        } else {
          // Session is still valid, restore it
          this.setSessionTimeout();
        }
      }

      // Auth service initialized
    } catch (error) {
      console.error('Failed to initialize auth service:', error);
      throw error;
    }
  }

  // Clear all active sessions (used during factory reset or when terminal not configured)
  private async clearAllSessions(): Promise<void> {
    try {
      // Get active session and end it - repeat until no more active sessions
      let activeSession = await this.dbManager.getActiveSession();
      let clearedCount = 0;

      while (activeSession) {
        await this.dbManager.endSession(activeSession.id);
        clearedCount++;
        activeSession = await this.dbManager.getActiveSession();
      }

      if (clearedCount > 0) {
        console.log(`[AuthService] Cleared ${clearedCount} active sessions`);
      }
    } catch (e) {
      console.error('[AuthService] Failed to clear all sessions:', e);
    }
  }
}