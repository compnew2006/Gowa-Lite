export type UserRole = 'admin' | 'agent';
export type ThemePreference = 'light' | 'dark' | 'system';
export type LanguagePreference = 'ar' | 'en';

export type PermissionResource =
  | 'chats'
  | 'notes'
  | 'schedules'
  | 'groups'
  | 'accounts'
  | 'misc'
  | 'users'
  | 'roles'
  | 'settings';

export interface PermissionItem {
  key: string;
  resource: PermissionResource;
  action: string;
}

export interface PermissionGroup {
  resource: PermissionResource;
  permissions: PermissionItem[];
}

export interface RoleRecord {
  id: number;
  name: string;
  slug: string;
  description: string;
  is_system: boolean;
  is_default: boolean;
  permissions: string[];
  user_count: number;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  role_id: number;
  role_slug: string;
  role_name: string;
  permissions: string[];
  allowed_device_ids: string[];
  is_active: boolean;
  created_at: string;
  theme: ThemePreference;
  language: LanguagePreference;
}

export interface UserCreatePayload {
  display_name: string;
  username: string;
  password: string;
  role_id?: number;
  role?: UserRole;
  allowed_device_ids?: string[];
}

export interface UserUpdatePayload {
  display_name?: string;
  role_id?: number;
  role?: UserRole;
  allowed_device_ids?: string[];
  is_active?: boolean;
  password?: string;
}

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  user: User | null;
  gowaConfigured: boolean;
}
