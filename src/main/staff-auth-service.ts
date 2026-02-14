import { supabase } from '../shared/supabase'
import * as crypto from 'crypto'
import { DatabaseManager } from './database'

export interface StaffAuthResult {
  success: boolean
  sessionId?: string
  staffId?: string
  role?: string
  permissions?: string[]
  error?: string
}

export interface StaffSession {
  id: string
  staff_id: string
  role: string
  permissions: string[]
  terminal_id?: string
  organization_id?: string
  login_at: string
  expires_at: string
}

export interface StaffMember {
  id: string
  staff_code: string
  first_name: string
  last_name: string
  email: string
  role: {
    id: string
    name: string
    display_name: string
    level: number
  }
  branch_id?: string
  department?: string
  is_active: boolean
  can_login_pos: boolean
  last_login_at?: string
}

export class StaffAuthService {
  private db: DatabaseManager
  private currentSession: StaffSession | null = null
  private onSessionTimeout?: (session: StaffSession) => void

  constructor() {
    this.db = new DatabaseManager()
  }

  async initialize(): Promise<void> {
    await this.db.initialize()
  }

  /**
   * Set callback for session timeout events
   */
  setSessionTimeoutCallback(callback: (session: StaffSession) => void): void {
    this.onSessionTimeout = callback
  }

  /**
   * Authenticate staff member with PIN
   */
  async authenticateWithPIN(pin: string, staffId?: string, terminalId?: string, branchId?: string, organizationId?: string): Promise<StaffAuthResult> {
    try {
      if (!branchId) {
        console.warn('[staff-auth] No branchId resolved for terminal when authenticating PIN; check terminal settings.');
      }

      // Resolve organizationId if not provided
      let effectiveOrgId = organizationId
      if (!effectiveOrgId && branchId) {
        try {
          const { data: branchData, error: branchError } = await supabase
            .from('branches')
            .select('organization_id')
            .eq('id', branchId)
            .single()

          if (!branchError && branchData) {
            effectiveOrgId = branchData.organization_id
          }
        } catch (err) {
          console.warn('[staff-auth] Could not resolve organization_id from branch:', err)
        }
      }

      // Verify PIN and create session via SECURITY DEFINER RPC (avoids RLS issues)
      const { data: rpcData, error: pinError } = await supabase
        .rpc('pos_checkin_staff', {
          p_staff_id: staffId,
          p_staff_pin: pin,
          p_branch_id: branchId ?? null,
          p_organization_id: effectiveOrgId ?? null,
          p_terminal_id: terminalId ?? null,
          p_session_hours: 8
        });

      if (pinError) {
        console.error('[staff-auth] pos_checkin_staff error:', pinError);
      }
      console.debug('[staff-auth] pos_checkin_staff data:', rpcData, { staffId, terminalId, branchId });

      const rpcRow: any = Array.isArray(rpcData) ? rpcData[0] : rpcData;

      if (pinError || !rpcRow || !rpcRow.success || !rpcRow.session_id || (staffId && rpcRow.staff_id !== staffId)) {
        // Only log if we have a staffId; the DB function requires staff_uuid
        if (staffId) {
          await this.logActivity(staffId, 'pos.login', null, null, 'access', {
            method: 'pin',
            result: 'failed',
            error: staffId && rpcRow?.staff_id && rpcRow.staff_id !== staffId ? 'PIN does not match selected staff' : 'Invalid PIN'
          }, 'failed')
        }

        return {
          success: false,
          error: 'Invalid PIN or staff member not found'
        }
      }

      const effectiveStaffId = rpcRow.staff_id

      // Do not fail authentication if follow-up staff select is blocked by RLS.
      // PIN/session creation is the source of truth and already succeeded above.
      let staffData: { id: string; role_id?: string | null } | null = null
      try {
        const { data } = await supabase
          .from('staff')
          .select('id, role_id')
          .eq('id', effectiveStaffId)
          .maybeSingle()
        if (data) {
          staffData = data as { id: string; role_id?: string | null }
        }
      } catch (staffLookupError) {
        console.warn('[staff-auth] Non-fatal staff lookup error after successful PIN RPC:', staffLookupError)
      }

      // Prefer role from RPC response to avoid dependency on relation shape.
      let resolvedRoleName = (rpcRow.role_name || '').toString().trim()
      if (!resolvedRoleName && staffData?.role_id) {
        try {
          const { data: roleRow } = await supabase
            .from('roles')
            .select('name')
            .eq('id', staffData.role_id)
            .single()
          resolvedRoleName = (roleRow?.name || '').toString().trim()
        } catch (roleResolveError) {
          console.warn('[staff-auth] Failed to resolve role name from role_id:', roleResolveError)
        }
      }
      if (!resolvedRoleName) {
        resolvedRoleName = 'staff'
      }

      // Get staff permissions (best effort)
      const permissions = await this.getStaffPermissions(effectiveStaffId, staffData?.role_id, resolvedRoleName)

      // Use session created by RPC and compute local expiry
      const sessionId = rpcRow.session_id
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000) // 8 hours

      // Store session locally (hashing is handled inside DB service)
      const localRole = this.mapRoleToLocal(resolvedRoleName)
      await this.db.createStaffSession(
        effectiveStaffId,
        pin,
        localRole
      )

      // Update last login
      try {
        await supabase
          .from('staff')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', effectiveStaffId)
      } catch (lastLoginError) {
        console.warn('[staff-auth] Non-fatal last_login update error:', lastLoginError)
      }

      // Set current session
      this.currentSession = {
        id: sessionId,
        staff_id: effectiveStaffId,
        role: resolvedRoleName,
        organization_id: effectiveOrgId,
        permissions,
        terminal_id: terminalId,
        login_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString()
      }

      // Log successful login
      await this.logActivity(effectiveStaffId, 'pos.login', null, null, 'access', {
        method: 'pin',
        terminal_id: terminalId,
        role: resolvedRoleName
      }, 'success')

      return {
        success: true,
        sessionId,
        staffId: effectiveStaffId,
        role: resolvedRoleName,
        permissions
      }

    } catch (error) {
      console.error('Authentication error:', error)
      return {
        success: false,
        error: 'Authentication failed'
      }
    }
  }

  /**
   * Get staff permissions (role + individual overrides)
   */
  async getStaffPermissions(
    staffId: string,
    roleId?: string | null,
    roleName?: string | null
  ): Promise<string[]> {
    try {
      let permissions: string[] = []

      let effectiveRoleId = roleId ?? null
      if (!effectiveRoleId && roleName) {
        const { data: roleByName } = await supabase
          .from('roles')
          .select('id')
          .eq('name', roleName)
          .single()
        effectiveRoleId = roleByName?.id ?? null
      }

      if (effectiveRoleId) {
        const { data: rolePermissionsRows } = await supabase
          .from('role_permissions')
          .select(`
            permission:permissions(name)
          `)
          .eq('role_id', effectiveRoleId)

        if (Array.isArray(rolePermissionsRows)) {
          permissions = rolePermissionsRows
            .map((rp: any) => rp?.permission?.name)
            .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
        }
      }

      // Get individual permission overrides
      const { data: individualPermissions, error: individualError } = await supabase
        .from('staff_permissions')
        .select(`
          granted,
          permission:permissions(name)
        `)
        .eq('staff_id', staffId)
        .or('expires_at.is.null,expires_at.gt.now()')

      if (!individualError && individualPermissions) {
        individualPermissions.forEach((sp: any) => {
          if (sp.granted) {
            // Grant permission
            if (!permissions.includes(sp.permission.name)) {
              permissions.push(sp.permission.name)
            }
          } else {
            // Revoke permission
            permissions = permissions.filter(p => p !== sp.permission.name)
          }
        })
      }

      if (permissions.length === 0 && roleName) {
        permissions = this.getDefaultPermissionsForRole(roleName)
      }

      return permissions

    } catch (error) {
      console.error('Error getting staff permissions:', error)
      if (roleName) {
        return this.getDefaultPermissionsForRole(roleName)
      }
      return []
    }
  }

  /**
   * Check if current staff has specific permission
   */
  async hasPermission(permission: string): Promise<boolean> {
    if (!this.currentSession) {
      return false
    }

    return this.currentSession.permissions.includes(permission)
  }

  /**
   * Check if current staff has any of the specified permissions
   */
  async hasAnyPermission(permissions: string[]): Promise<boolean> {
    if (!this.currentSession) {
      return false
    }

    return permissions.some(permission =>
      this.currentSession!.permissions.includes(permission)
    )
  }

  /**
   * Get current session
   */
  getCurrentSession(): StaffSession | null {
    return this.currentSession
  }

  /**
   * Get current staff member
   */
  async getCurrentStaff(): Promise<StaffMember | null> {
    if (!this.currentSession) {
      return null
    }

    try {
      const { data: staffData, error } = await supabase
        .from('staff')
        .select(`
          *,
          role:roles(*)
        `)
        .eq('id', this.currentSession.staff_id)
        .single()

      if (error || !staffData) {
        return null
      }

      return {
        id: staffData.id,
        staff_code: staffData.staff_code,
        first_name: staffData.first_name,
        last_name: staffData.last_name,
        email: staffData.email,
        role: {
          id: staffData.role.id,
          name: staffData.role.name,
          display_name: staffData.role.display_name,
          level: staffData.role.level
        },
        branch_id: staffData.branch_id,
        department: staffData.department,
        is_active: staffData.is_active,
        can_login_pos: staffData.can_login_pos,
        last_login_at: staffData.last_login_at
      }

    } catch (error) {
      console.error('Error getting current staff:', error)
      return null
    }
  }

  /**
   * Logout current session
   */
  async logout(): Promise<void> {
    if (!this.currentSession) {
      return
    }

    try {
      // Update session in Supabase
      await supabase
        .from('staff_sessions')
        .update({
          is_active: false,
          logout_at: new Date().toISOString(),
          logout_reason: 'manual'
        })
        .eq('id', this.currentSession.id)

      // Log logout activity
      await this.logActivity(
        this.currentSession.staff_id,
        'logout',
        'authentication',
        null,
        'logout',
        {
          session_duration: Date.now() - new Date(this.currentSession.login_at).getTime(),
          method: 'manual'
        },
        'success'
      )

      // End local session
      const localSession = await this.db.getActiveSession()
      if (localSession) {
        await this.db.endSession(localSession.id)
      }

      this.currentSession = null

    } catch (error) {
      console.error('Error during logout:', error)
    }
  }

  /**
   * Force logout (admin action)
   */
  async forceLogout(reason: string = 'admin_forced'): Promise<void> {
    if (!this.currentSession) {
      return
    }

    try {
      await supabase
        .from('staff_sessions')
        .update({
          is_active: false,
          logout_at: new Date().toISOString(),
          logout_reason: reason,
          forced_logout: true
        })
        .eq('id', this.currentSession.id)

      // Log forced logout
      await this.logActivity(
        this.currentSession.staff_id,
        'logout',
        'authentication',
        null,
        'force_logout',
        { reason },
        'success'
      )

      this.currentSession = null

    } catch (error) {
      console.error('Error during force logout:', error)
    }
  }

  /**
   * Validate current session
   */
  async validateSession(): Promise<{ valid: boolean }> {
    if (!this.currentSession) {
      return { valid: false }
    }

    // Check if session expired
    if (new Date() > new Date(this.currentSession.expires_at)) {
      const expiredSession = { ...this.currentSession }
      await this.logout()

      // Emit session timeout event
      if (this.onSessionTimeout) {
        this.onSessionTimeout(expiredSession)
      }

      return { valid: false }
    }

    try {
      // Validate session via SECURITY DEFINER RPC (bypasses RLS on staff_sessions)
      const { data: rpcData, error } = await supabase.rpc('pos_validate_staff_session', {
        p_session_id: this.currentSession.id,
      })

      if (error) {
        console.error('Error validating session via RPC:', error)
        return { valid: false }
      }

      const row: any = Array.isArray(rpcData) ? rpcData[0] : rpcData
      if (!row || !row.valid) {
        const expiredSession = this.currentSession
        this.currentSession = null
        if (this.onSessionTimeout && expiredSession) {
          this.onSessionTimeout(expiredSession)
        }
        return { valid: false }
      }

      // Optionally refresh local expiry from DB
      if (row.expires_at) {
        this.currentSession.expires_at = new Date(row.expires_at).toISOString()
      }

      return { valid: true }

    } catch (error) {
      console.error('Error validating session:', error)
      return { valid: false }
    }
  }

  /**
   * Track staff activity
   */
  async trackActivity(
    activityType: string,
    resourceType: string | null,
    resourceId: string | null,
    action: string,
    details: Record<string, any> = {},
    result: string = 'success'
  ): Promise<void> {
    if (!this.currentSession) {
      return
    }

    await this.logActivity(
      this.currentSession.staff_id,
      activityType,
      resourceType,
      resourceId,
      action,
      details,
      result
    )
  }

  /**
   * Log staff activity
   */
  private async logActivity(
    staffId: string | null,
    activityType: string,
    resourceType: string | null,
    resourceId: string | null,
    action: string,
    details: Record<string, any> = {},
    result: string = 'success'
  ): Promise<void> {
    if (!staffId) return; // DB function requires staff_uuid
    try {
      const { activity_type, normalizedAction } = this.normalizeActivity(activityType, action, resourceType || undefined)
      await supabase.rpc('log_staff_activity', {
        staff_uuid: staffId,
        session_uuid: this.currentSession?.id || null,
        activity_type,
        action: normalizedAction,
        result_param: result,
        resource_id_param: resourceId || null,
        // Preserve resource_type within details since DB function signature doesn't accept it directly
        details_param: { ...(details || {}), ...(resourceType ? { resource_type: resourceType } : {}) }
      })
    } catch (error) {
      console.error('Error logging activity:', error)
    }
  }

  /** Map arbitrary activity/action to the secure function's allowed values */
  private normalizeActivity(activityType: string, action: string, resourceType?: string): { activity_type: string; normalizedAction: 'read' | 'create' | 'update' | 'delete' | 'access' } {
    const act = (action || '').toLowerCase()
    const type = (activityType || '').toLowerCase()
    // Default
    let mappedType: string = 'pos.order_modified'
    let mappedAction: 'read' | 'create' | 'update' | 'delete' | 'access' = 'access'

    if (type.includes('login')) {
      mappedType = 'pos.login'
      mappedAction = 'access'
    } else if (type.includes('logout')) {
      mappedType = 'pos.logout'
      mappedAction = 'access'
    } else if (type.includes('order')) {
      mappedType = act === 'create' ? 'pos.order_created' : 'pos.order_modified'
      mappedAction = (act === 'create' ? 'create' : 'update')
    } else if (type.includes('payment')) {
      mappedType = 'pos.payment_processed'
      mappedAction = 'create'
    } else if (type.includes('cash') || (resourceType || '').includes('cash_drawer')) {
      mappedType = 'pos.cash_drawer_opened'
      mappedAction = 'access'
    } else if (type.includes('shift') && act.includes('start')) {
      mappedType = 'pos.shift_started'
      mappedAction = 'access'
    } else if (type.includes('shift') && (act.includes('end') || act.includes('close'))) {
      mappedType = 'pos.shift_ended'
      mappedAction = 'access'
    }

    return { activity_type: mappedType, normalizedAction: mappedAction }
  }

  /**
   * Generate secure session token
   */
  private generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  /**
   * Hash PIN for local storage
   */
  private hashPin(pin: string): string {
    return crypto.createHash('sha256').update(pin).digest('hex')
  }
  /**
   * Map server role name to local SQLite role enum
   */
  private mapRoleToLocal(roleName: string): 'admin' | 'staff' {
    const r = (roleName || '').toLowerCase();
    if (['admin', 'owner', 'manager'].includes(r)) return 'admin';
    return 'staff';
  }

  /**
   * Local fallback permissions if role-permission tables are unavailable due RLS/config.
   */
  private getDefaultPermissionsForRole(roleName: string): string[] {
    const r = (roleName || '').toLowerCase();
    if (['admin', 'owner'].includes(r)) {
      return [
        'view_orders',
        'update_order_status',
        'create_order',
        'delete_order',
        'view_reports',
        'manage_staff',
        'system_settings',
        'force_sync',
        'assign_driver',
        'manage_delivery',
        'edit_order'
      ];
    }
    if (r === 'manager') {
      return [
        'view_orders',
        'update_order_status',
        'create_order',
        'view_reports',
        'manage_staff',
        'assign_driver',
        'manage_delivery',
        'edit_order'
      ];
    }
    if (r === 'driver') {
      return [
        'view_orders',
        'update_order_status',
        'assign_driver',
        'manage_delivery'
      ];
    }
    if (r === 'kitchen') {
      return [
        'view_orders',
        'update_order_status'
      ];
    }
    return [
      'view_orders',
      'create_order',
      'update_order_status',
      'edit_order'
    ];
  }


  /**
   * Get all active staff sessions (admin function)
   */
  async getActiveSessions(): Promise<any[]> {
    try {
      const { data, error } = await supabase
        .from('staff_sessions')
        .select(`
          *,
          staff:staff_id(
            staff_code,
            first_name,
            last_name,
            role:roles(display_name)
          )
        `)
        .eq('is_active', true)
        .order('login_at', { ascending: false })

      if (error) throw error
      return data || []

    } catch (error) {
      console.error('Error getting active sessions:', error)
      return []
    }
  }

  /**
   * Force logout all sessions for a specific staff member
   */
  async forceLogoutStaff(staffId: string, reason: string = 'admin_action'): Promise<void> {
    try {
      await supabase
        .from('staff_sessions')
        .update({
          is_active: false,
          logout_at: new Date().toISOString(),
          logout_reason: reason,
          forced_logout: true
        })
        .eq('staff_id', staffId)
        .eq('is_active', true)

    } catch (error) {
      console.error('Error forcing logout for staff:', error)
    }
  }
}

export default StaffAuthService
