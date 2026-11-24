import {useMemo, useState} from 'react';
import {AlertCircle, Plus, RefreshCw, Search} from 'lucide-react';
import type {AssignableAccountSummary} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
  mergeManualDeviceId,
  type DeviceAccessMode,
} from '@/features/users/device-access-helpers';
import {useI18n} from '@/lib/i18n';

interface DeviceAccessSelectorProps {
  idPrefix: string;
  accounts: AssignableAccountSummary[];
  mode: DeviceAccessMode;
  selectedIds: string[];
  onModeChange: (nextMode: DeviceAccessMode) => void;
  onChange: (nextIds: string[]) => void;
  gowaReachable?: boolean;
  onRetryAccounts?: () => void;
  isRetrying?: boolean;
  disabled?: boolean;
  showValidationError?: boolean;
}

export function DeviceAccessSelector({
  idPrefix,
  accounts,
  mode,
  selectedIds,
  onModeChange,
  onChange,
  gowaReachable = true,
  onRetryAccounts,
  isRetrying = false,
  disabled = false,
  showValidationError = false,
}: DeviceAccessSelectorProps) {
  const {t} = useI18n();
  const [accountSearch, setAccountSearch] = useState('');
  const [manualId, setManualId] = useState('');

  const knownIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const combinedAccounts = useMemo<AssignableAccountSummary[]>(() => {
    const extraIds = selectedIds.filter((id) => !knownIds.has(id));
    return [
      ...accounts,
      ...extraIds.map((id) => ({
        id,
        display_name: id,
        phone_number: null,
        state: 'disconnected' as const,
        source: 'cached' as const,
      })),
    ];
  }, [accounts, knownIds, selectedIds]);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return combinedAccounts;
    return combinedAccounts.filter(
      (acc) =>
        acc.display_name.toLowerCase().includes(q) ||
        acc.id.toLowerCase().includes(q) ||
        (acc.phone_number ?? '').toLowerCase().includes(q),
    );
  }, [accountSearch, combinedAccounts]);

  const toggleAccount = (accountId: string) => {
    if (disabled) return;
    if (mode !== 'specific') {
      onModeChange('specific');
    }
    const exists = selectedIds.includes(accountId);
    const next = exists
      ? selectedIds.filter((id) => id !== accountId)
      : [...selectedIds, accountId];
    onChange(next);
  };

  const handleSelectAll = () => {
    if (disabled) return;
    onModeChange('specific');
    onChange(combinedAccounts.map((a) => a.id));
  };

  const handleClearSelection = () => {
    if (disabled) return;
    onModeChange('specific');
    onChange([]);
  };

  const handleAddManualId = () => {
    const clean = manualId.trim();
    if (!clean || disabled) return;
    onModeChange('specific');
    onChange(mergeManualDeviceId(selectedIds, clean));
    setManualId('');
  };

  const isMissingSelection = mode === 'specific' && selectedIds.length === 0;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{t.users.deviceAccessLabel}</span>
        {mode === 'specific' && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t.users.deviceAccessSelectedCount(selectedIds.length, combinedAccounts.length)}
          </span>
        )}
      </div>

      {!gowaReachable && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          <span className="flex items-center gap-1.5">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{t.users.deviceAccessOfflineNotice}</span>
          </span>
          {onRetryAccounts && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRetryAccounts}
              disabled={isRetrying}
              className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`size-3 ${isRetrying ? 'animate-spin' : ''}`} />
              <span>{t.users.deviceAccessRetry}</span>
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5 text-xs">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`${idPrefix}-device-mode`}
            checked={mode === 'all'}
            disabled={disabled}
            onChange={() => onModeChange('all')}
            className="accent-primary focus-visible:outline-2 focus-visible:outline-ring"
          />
          <span className="font-medium text-foreground">{t.users.deviceAccessAllOption}</span>
        </label>
        <p className="ps-5 text-[11px] text-muted-foreground">{t.users.deviceAccessAllHint}</p>

        <label className="mt-1 flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`${idPrefix}-device-mode`}
            checked={mode === 'specific'}
            disabled={disabled}
            onChange={() => onModeChange('specific')}
            className="accent-primary focus-visible:outline-2 focus-visible:outline-ring"
          />
          <span className="font-medium text-foreground">{t.users.deviceAccessSpecificOption}</span>
        </label>
        <p className="ps-5 text-[11px] text-muted-foreground">{t.users.deviceAccessSpecificHint}</p>
      </div>

      {mode === 'specific' && (
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
          {combinedAccounts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {combinedAccounts.length >= 4 ? (
                <div className="relative min-w-36 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 start-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={accountSearch}
                    onChange={(e) => setAccountSearch(e.target.value)}
                    placeholder={t.users.deviceAccessSearchPlaceholder}
                    className="h-8 ps-8 text-xs"
                    disabled={disabled}
                  />
                </div>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSelectAll}
                  disabled={disabled || combinedAccounts.length === 0}
                  className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
                >
                  {t.users.deviceAccessSelectAll}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearSelection}
                  disabled={disabled || selectedIds.length === 0}
                  className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
                >
                  {t.users.deviceAccessClearSelection}
                </Button>
              </div>
            </div>
          )}

          {combinedAccounts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t.users.deviceAccessNoAccounts}</p>
          ) : (
            <div className="grid max-h-44 gap-1 overflow-y-auto pe-1">
              {filteredAccounts.map((acc) => {
                const checked = selectedIds.includes(acc.id);
                const stateLabel =
                  acc.source === 'cached'
                    ? t.users.deviceAccessCachedTag
                    : t.accounts.states[acc.state] || acc.state;
                return (
                  <label
                    key={acc.id}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAccount(acc.id)}
                        className="size-3.5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                      />
                      <span className="truncate font-medium text-foreground">
                        {acc.display_name}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span dir="ltr" className="font-mono">
                        {acc.phone_number || acc.id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{stateLabel}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-border/70 pt-2">
            <Input
              dir="ltr"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddManualId();
                }
              }}
              placeholder={`${t.users.deviceAccessManualLabel} (${t.users.deviceAccessManualPlaceholder})`}
              className="h-8 flex-1 text-xs"
              disabled={disabled}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddManualId}
              disabled={disabled || !manualId.trim()}
              className="h-8 px-2.5 text-xs whitespace-nowrap shrink-0"
            >
              <Plus className="size-3.5" />
              <span>{t.users.deviceAccessManualAdd}</span>
            </Button>
          </div>

          {showValidationError && isMissingSelection && (
            <p className="text-[11px] font-medium text-destructive">
              {t.users.deviceAccessSelectPrompt}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
