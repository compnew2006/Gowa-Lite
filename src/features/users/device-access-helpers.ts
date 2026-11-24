export type DeviceAccessMode = 'all' | 'specific';

export type DeviceAccessValidationResult =
  | {ok: true; deviceIds: string[]}
  | {ok: false};

export function validateDeviceAccessSelection(
  mode: DeviceAccessMode,
  selectedIds: string[],
): DeviceAccessValidationResult {
  if (mode === 'all') {
    return {ok: true, deviceIds: []};
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of selectedIds) {
    const clean = raw.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      normalized.push(clean);
    }
  }
  if (normalized.length === 0) {
    return {ok: false};
  }
  return {ok: true, deviceIds: normalized};
}

export function mergeManualDeviceId(currentIds: string[], rawDeviceId: string): string[] {
  const clean = rawDeviceId.trim();
  if (!clean) return currentIds;
  if (currentIds.includes(clean)) return currentIds;
  return [...currentIds, clean];
}

export function summarizeAssignedAccounts(
  deviceIds: string[],
  accountNameMap: Map<string, string>,
  allAccountsLabel: string,
  maxVisible = 2,
): string {
  if (!deviceIds || deviceIds.length === 0) {
    return allAccountsLabel;
  }
  const labels = deviceIds.map((id) => accountNameMap.get(id) ?? id);
  if (labels.length <= maxVisible) {
    return labels.join(' · ');
  }
  const shown = labels.slice(0, maxVisible).join(' · ');
  return `${shown} (+${labels.length - maxVisible})`;
}
