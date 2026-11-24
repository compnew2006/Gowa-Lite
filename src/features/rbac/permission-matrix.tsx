import {useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, Lock, Search} from 'lucide-react';
import type {PermissionGroup} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

interface PermissionMatrixProps {
  groups: PermissionGroup[];
  selectedKeys: string[];
  onChange: (nextKeys: string[]) => void;
  readOnly?: boolean;
  disabledKeys?: Set<string>;
}

export function PermissionMatrix({
  groups,
  selectedKeys,
  onChange,
  readOnly = false,
  disabledKeys,
}: PermissionMatrixProps) {
  const {t, isRtl} = useI18n();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const query = search.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => {
        const resourceLabel = t.rbac.resources[group.resource] ?? group.resource;
        const resourceMatches =
          !query ||
          resourceLabel.toLowerCase().includes(query) ||
          group.resource.toLowerCase().includes(query);
        const permissions = (group.permissions ?? []).filter((perm) => {
          if (resourceMatches) return true;
          const actionLabel = t.rbac.actions[perm.key] ?? perm.key;
          return (
            perm.key.toLowerCase().includes(query) || actionLabel.toLowerCase().includes(query)
          );
        });
        return {...group, permissions};
      })
      .filter((group) => group.permissions.length > 0);
  }, [groups, query, t.rbac.actions, t.rbac.resources]);

  const visibleEditableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const group of filteredGroups) {
      for (const perm of group.permissions) {
        if (!readOnly && !disabledKeys?.has(perm.key)) {
          keys.push(perm.key);
        }
      }
    }
    return keys;
  }, [disabledKeys, filteredGroups, readOnly]);

  const toggleKey = (key: string) => {
    if (readOnly || disabledKeys?.has(key)) return;
    const next = new Set(selectedSet);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onChange(Array.from(next));
  };

  const toggleGroup = (keys: string[]) => {
    if (readOnly) return;
    const editableKeys = keys.filter((k) => !disabledKeys?.has(k));
    if (editableKeys.length === 0) return;
    const allEditableSelected = editableKeys.every((k) => selectedSet.has(k));
    const next = new Set(selectedSet);
    for (const key of editableKeys) {
      if (allEditableSelected) {
        next.delete(key);
      } else {
        next.add(key);
      }
    }
    onChange(Array.from(next));
  };

  const selectAllVisible = () => {
    if (readOnly || visibleEditableKeys.length === 0) return;
    const next = new Set(selectedSet);
    for (const key of visibleEditableKeys) {
      next.add(key);
    }
    onChange(Array.from(next));
  };

  const clearAllVisible = () => {
    if (readOnly || visibleEditableKeys.length === 0) return;
    const next = new Set(selectedSet);
    for (const key of visibleEditableKeys) {
      next.delete(key);
    }
    onChange(Array.from(next));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.roles.searchPermsPlaceholder}
            className="h-9 ps-9 text-sm"
          />
        </div>

        {!readOnly && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectAllVisible}
              disabled={visibleEditableKeys.length === 0}
              className="whitespace-nowrap shrink-0"
            >
              {t.roles.selectAllVisible}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearAllVisible}
              disabled={visibleEditableKeys.length === 0}
              className="whitespace-nowrap shrink-0"
            >
              {t.roles.clearAllVisible}
            </Button>
          </div>
        )}
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          {t.roles.noMatchingPerms}
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {filteredGroups.map((group) => {
            const keys = group.permissions.map((perm) => perm.key);
            const selectedCount = keys.filter((k) => selectedSet.has(k)).length;
            const allSelected = selectedCount === keys.length && keys.length > 0;
            const someSelected = selectedCount > 0 && selectedCount < keys.length;
            const isCollapsed = Boolean(collapsed[group.resource]) && !query;
            const hasEditableInGroup = !readOnly && keys.some((k) => !disabledKeys?.has(k));

            return (
              <div key={group.resource} className="bg-card">
                <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <input
                      type="checkbox"
                      aria-label={t.rbac.resources[group.resource] ?? group.resource}
                      checked={allSelected}
                      disabled={!hasEditableInGroup}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={() => toggleGroup(keys)}
                      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [group.resource]: !prev[group.resource],
                        }))
                      }
                      className="flex min-w-0 cursor-pointer items-center gap-1.5 text-start text-sm font-semibold text-foreground"
                    >
                      {isCollapsed ? (
                        isRtl ? (
                          <ChevronDown className="size-4 shrink-0 rotate-90 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        )
                      ) : (
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {t.rbac.resources[group.resource] ?? group.resource}
                      </span>
                    </button>
                  </div>

                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {t.roles.selectedCounter(selectedCount, keys.length)}
                  </span>
                </div>

                {!isCollapsed && (
                  <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-2">
                    {group.permissions.map((perm) => {
                      const key = perm.key;
                      const checked = selectedSet.has(key);
                      const isLocked = Boolean(disabledKeys?.has(key));
                      const disabled = readOnly || isLocked;
                      const label = t.rbac.actions[key] ?? key;

                      return (
                        <label
                          key={key}
                          className={cn(
                            'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors',
                            disabled
                              ? 'cursor-default opacity-80'
                              : 'cursor-pointer hover:bg-muted/40',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleKey(key)}
                            className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                              <span>{label}</span>
                              {isLocked && !readOnly && (
                                <Lock className="size-3 shrink-0 text-muted-foreground" />
                              )}
                            </div>
                            <p dir="ltr" className="text-start font-mono text-[11px] text-muted-foreground">
                              {key}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
