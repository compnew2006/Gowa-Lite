import {create} from 'zustand';
import type {LanguagePreference, ThemePreference, User} from '@/api/types';
import {queryClient} from '@/lib/query-client';

export type AuthBootStatus = 'booting' | 'needs_setup' | 'unauthenticated' | 'authenticated';

interface AuthState {
  status: AuthBootStatus;
  token: string | null;
  user: User | null;
  gowaConfigured: boolean;
  theme: ThemePreference;
  language: LanguagePreference;
  setSession: (token: string, user: User, gowaConfigured?: boolean) => void;
  setUser: (user: User) => void;
  setGowaConfigured: (configured: boolean) => void;
  setThemeLocal: (theme: ThemePreference) => void;
  setLanguageLocal: (language: LanguagePreference) => void;
  clearSession: (needsSetup?: boolean) => void;
  setBootState: (payload: {
    status: AuthBootStatus;
    user?: User | null;
    gowaConfigured?: boolean;
  }) => void;
}

export function hasSameAccessScope(previous: User | null, current: User | null): boolean {
  if (!previous || !current) return previous === current;
  const sameMembers = (left: string[], right: string[]) =>
    left.length === right.length && left.every((item) => right.includes(item));
  return previous.id === current.id && previous.role_id === current.role_id &&
    sameMembers(previous.permissions, current.permissions) &&
    sameMembers(previous.allowed_device_ids, current.allowed_device_ids);
}

export function applyThemeToDom(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const isDark = theme !== 'light';
  root.classList.toggle('dark', isDark);
}

export function applyLanguageToDom(language: LanguagePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = language;
  root.dir = language === 'ar' ? 'rtl' : 'ltr';
}

export function isAdminUser(user: User | null | undefined): boolean {
  if (!user) return false;
  return user.role_slug === 'admin' || user.role === 'admin';
}

export function hasUserPermission(user: User | null | undefined, key: string): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    return user.permissions.includes(key);
  }
  return false;
}

export function hasUserAnyPermission(user: User | null | undefined, keys: string[]): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return keys.some((key) => hasUserPermission(user, key));
}

export function hasUserDeviceAccess(
  user: User | null | undefined,
  deviceId: string | null | undefined,
): boolean {
  if (!user || !deviceId) return false;
  if (!Array.isArray(user.allowed_device_ids) || user.allowed_device_ids.length === 0) {
    return true;
  }
  return user.allowed_device_ids.includes(deviceId);
}

export function firstAllowedRoute(user: User | null | undefined): string {
  if (!user) return '/login';
  if (hasUserPermission(user, 'chats:read')) return '/chats';
  if (hasUserAnyPermission(user, ['schedules:read', 'schedules:write', 'schedules:manage'])) {
    return '/scheduled';
  }
  if (hasUserAnyPermission(user, ['groups:read', 'groups:write', 'groups:manage'])) {
    return '/groups';
  }
  if (hasUserAnyPermission(user, ['accounts:read', 'accounts:write'])) return '/account';
  if (hasUserAnyPermission(user, ['misc:status.read', 'misc:channels.manage', 'misc:calls.reject'])) {
    return '/misc';
  }
  if (hasUserAnyPermission(user, ['accounts:read', 'accounts:write'])) return '/accounts';
  if (hasUserAnyPermission(user, ['settings:read', 'settings:write'])) return '/settings';
  if (hasUserAnyPermission(user, ['users:read', 'users:write', 'users:delete'])) {
    return '/settings/users';
  }
  if (hasUserAnyPermission(user, ['roles:read', 'roles:write', 'roles:delete'])) {
    return '/settings/roles';
  }
  return '/chats';
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'booting',
  token: null,
  user: null,
  gowaConfigured: false,
  theme: 'dark',
  language: 'ar',

  setSession: (token, user, gowaConfigured) => {
    applyThemeToDom(user.theme);
    applyLanguageToDom(user.language ?? 'ar');
    set((state) => ({
      status: 'authenticated',
      token,
      user,
      theme: user.theme,
      language: user.language ?? 'ar',
      gowaConfigured: gowaConfigured ?? state.gowaConfigured,
    }));
  },

  setUser: (user) => {
    applyThemeToDom(user.theme);
    applyLanguageToDom(user.language ?? 'ar');
    set({user, theme: user.theme, language: user.language ?? 'ar'});
  },

  setGowaConfigured: (gowaConfigured) => set({gowaConfigured}),

  setThemeLocal: (theme) => {
    applyThemeToDom(theme);
    set((state) => ({
      theme,
      user: state.user ? {...state.user, theme} : null,
    }));
  },

  setLanguageLocal: (language) => {
    applyLanguageToDom(language);
    set((state) => ({
      language,
      user: state.user ? {...state.user, language} : null,
    }));
  },

  clearSession: (needsSetup = false) => {
    queryClient.clear();
    set({
      status: needsSetup ? 'needs_setup' : 'unauthenticated',
      token: null,
      user: null,
    });
  },

  setBootState: ({status, user = null, gowaConfigured = false}) => {
    if (user) {
      applyThemeToDom(user.theme);
      applyLanguageToDom(user.language ?? 'ar');
    }
    set((state) => ({
      status,
      user,
      gowaConfigured,
      theme: user?.theme ?? state.theme,
      language: user?.language ?? state.language,
    }));
  },
}));
