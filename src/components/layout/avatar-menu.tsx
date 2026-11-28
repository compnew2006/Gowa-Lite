import {useEffect, useRef, useState} from 'react';
import {LogOut, Moon, Sun} from 'lucide-react';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

/**
 * P1-13 (decision 14): the operator avatar in the app shell opens a small
 * menu — name + role, theme toggle, logout. No preferences page (later step).
 * The menu opens towards the workspace (inline-end) so it stays on screen in
 * both RTL and LTR, and closes on Escape, on an outside click, or after an
 * action is chosen.
 */
export function AvatarMenu({
  displayName,
  roleDisplayName,
  isDark,
  onToggleTheme,
  onLogout,
}: {
  displayName: string;
  roleDisplayName: string;
  isDark: boolean;
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleTheme = () => {
    setOpen(false);
    onToggleTheme();
  };

  const handleLogout = () => {
    setOpen(false);
    onLogout();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.nav.accountMenu}
        title={`${displayName} (${roleDisplayName})`}
        className="mt-1 flex size-9 cursor-pointer items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground select-none focus-visible:outline-2 focus-visible:outline-ring"
      >
        {displayName.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t.nav.accountMenu}
          className="absolute bottom-0 end-full z-50 me-2 w-60 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{roleDisplayName}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={handleTheme}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-start text-sm text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {isDark ? t.nav.lightMode : t.nav.darkMode}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-start text-sm',
              'text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive',
              'focus-visible:outline-2 focus-visible:outline-ring',
            )}
          >
            <LogOut className="size-4" />
            {t.nav.logout}
          </button>
        </div>
      )}
    </div>
  );
}
