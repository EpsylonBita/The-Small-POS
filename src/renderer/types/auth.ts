// Basic user interface definition
export interface User {
  staffId: string;
  databaseStaffId?: string | null;
  staffName?: string;
  role: {
    name: string;
    permissions?: string[];
  };
  loginTime: string;
}

export interface LoginCredentials {
  staffId: string;
  pin: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  user?: User;
} 
