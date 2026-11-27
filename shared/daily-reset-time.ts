export function isValidIanaTimezone(timezone: string): boolean {
  const clean = timezone.trim();
  if (!clean) return true;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: clean});
    return true;
  } catch {
    return false;
  }
}

export function resolveLocalDateAndHour(
  now: Date,
  timezone?: string,
): {dateKey: string; hour: number} {
  const tz = timezone?.trim() || undefined;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  }

  const parts = formatter.formatToParts(now);
  let year = '';
  let month = '';
  let day = '';
  let hourStr = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hourStr = part.value;
  }
  const parsedHour = Number.parseInt(hourStr, 10);
  const hour = Number.isFinite(parsedHour) ? Math.min(23, Math.max(0, parsedHour % 24)) : now.getHours();
  const dateKey =
    year && month && day
      ? `${year}-${month}-${day}`
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {dateKey, hour};
}
