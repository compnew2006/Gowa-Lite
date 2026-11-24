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
