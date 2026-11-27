import {useEffect, useRef, useState} from 'react';
import {Check, ChevronDown} from 'lucide-react';
import type {AccountSummary} from '@/api/types';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function AccountMultiSelect({
  accounts,
  selectedDeviceIds,
  onChange,
  compactPill = false,
}: {
  accounts: AccountSummary[];
  selectedDeviceIds: string[];
  onChange: (deviceIds: string[]) => void;
  compactPill?: boolean;
}) {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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

  const validSelected = selectedDeviceIds.filter((id) => accounts.some((a) => a.id === id));

  let summaryText: string;
  if (validSelected.length === 0) {
    summaryText = t.chats.allAccounts(accounts.length);
  } else if (validSelected.length === 1) {
    const match = accounts.find((a) => a.id === validSelected[0]);
    summaryText = match?.display_name ?? validSelected[0];
  } else {
    summaryText = t.chats.selectedAccountsCount(validSelected.length);
  }

  const toggleDevice = (deviceId: string) => {
    const exists = validSelected.includes(deviceId);
    const next = exists
      ? validSelected.filter((id) => id !== deviceId)
      : [...validSelected, deviceId];
    onChange(next);
  };

  return (
    <div ref={containerRef} className={cn('relative', compactPill ? 'shrink-0' : 'min-w-0 flex-1')}>
      <button
        type="button"
        aria-label={t.chats.filterByAccountAria}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex cursor-pointer items-center justify-between gap-1.5 rounded-full text-start whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          compactPill
            ? cn(
                'h-8 border px-3 text-xs font-medium',
                validSelected.length > 0
                  ? 'border-primary/25 bg-accent text-accent-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
              )
            : 'h-9 w-full bg-secondary px-3 text-xs font-medium text-foreground hover:bg-muted',
        )}
      >
        <span className={cn('truncate', compactPill ? 'max-w-[220px]' : 'min-w-0 flex-1')}>
          {summaryText}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 opacity-75 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute start-0 top-full z-30 mt-1.5 min-w-[230px] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-[0_4px_20px_rgba(11,20,26,0.14)]"
        >
          <button
            type="button"
            onClick={() => onChange([])}
            className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-border px-3 py-2 text-start text-xs font-medium transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>{t.chats.clearSelectionShowAll}</span>
            {validSelected.length === 0 && <Check className="size-3.5 shrink-0 text-primary" />}
          </button>

          <div className="max-h-60 overflow-y-auto py-1">
            {accounts.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t.chats.noAccountsAvailable}
              </p>
            ) : (
              accounts.map((acc) => {
                const checked = validSelected.includes(acc.id);
                return (
                  <button
                    key={acc.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggleDevice(acc.id)}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start text-xs transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-card',
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {acc.display_name}
                    </span>
                    {acc.state !== 'logged_in' && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t.chats.offlineTag}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
