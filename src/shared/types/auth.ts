// Consolidated Authentication Types for POS System

export interface User {
  id?: string;
  staffId: string;
  staffName?: string;
  role: {
    name: string;
    permissions?: string[];
  };
  loginTime: string;
}

export interface LoginCredentials {
  staffId?: string;
  pin?: string;
  username?: string;
  password?: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  user?: User;
}

export interface AuthResult {
  success: boolean;
  user?: {
    id: string;
    name: string;
    role: string;
  };
  token?: string;
  error?: string;
}

export interface StaffSession {
  id: string;
  staff_id: string;
  session_token: string;
  created_at: string;
  expires_at: string;
  is_active: boolean;
  last_activity: string;
  terminal_id?: string;
  ip_address?: string;
}

export interface StaffInfo {
  id: string;
  staff_id: string;
  name: string;
  role: string;
  permissions: string[];
  pin_hash?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
