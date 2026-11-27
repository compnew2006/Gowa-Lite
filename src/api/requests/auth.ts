import {http, results} from '@/lib/http';
import type {
  AuthStatus,
  LanguagePreference,
  ThemePreference,
  User,
} from '@/api/contracts/auth';

export function getAuthStatus(): Promise<AuthStatus> {
  return results(http.get('/auth/status'));
}

export function submitInitialSetup(payload: {
  display_name: string;
  username: string;
  password: string;
  gowa_url?: string;
  gowa_username?: string;
  gowa_password?: string;
}): Promise<{token: string; user: User}> {
  return results(http.post('/auth/setup', payload));
}

export function loginUser(payload: {
  username: string;
  password: string;
}): Promise<{token: string; user: User}> {
  return results(http.post('/auth/login', payload));
}

export async function logoutUser(): Promise<void> {
  await http.post('/auth/logout');
}

export function updateMyPreferences(payload: {
  theme?: ThemePreference;
  language?: LanguagePreference;
}): Promise<User> {
  return results(http.put('/me/preferences', payload));
}

export function updateMyTheme(theme: ThemePreference): Promise<User> {
  return updateMyPreferences({theme});
}

// Users & RBAC Roles
