import {Smartphone} from 'lucide-react';
import type {RegistryDevice} from '@/api/types';
import {formatDate} from '@/lib/format';
import {useI18n} from '@/lib/i18n';

export interface ScheduleAccount {
  name: string;
  number: string;
}

/**
 * Resolve the sending account's display name + number from a registry device,
 * with the same precedence the device selector bar uses: the server-resolved
 * name first, then the operator alias, then the gateway display name, then
 * the device id. The number is always shown: the phone number when known,
 * otherwise the device id.
 */
export function resolveScheduleAccount(
  device: RegistryDevice | null | undefined,
): ScheduleAccount | null {
  if (!device) return null;
  return {
    name: device.resolved_name || device.alias || device.display_name || device.id,
    number: device.phone_number || device.id,
  };
}

/**
 * Fixed line at the top of a schedule form showing which account the message
 * will be sent from. Read-only: the account comes from the open chat
 * (dialog) or the currently selected device (scheduled page), never from a
 * choice inside the form.
 */
export function ScheduleAccountLine({device}: {device: RegistryDevice | null}) {
  const {t} = useI18n();
  const account = resolveScheduleAccount(device);
  return (
    <div
      data-testid="schedule-account-line"
      className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <Smartphone className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-foreground">{t.scheduled.accountLabel}</span>
      {account ? (
        <span className="min-w-0 truncate text-muted-foreground">
          <span className="font-medium text-foreground">{account.name}</span>
          <span dir="ltr"> ({account.number})</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{t.scheduled.accountUnknown}</span>
      )}
    </div>
  );
}

/**
 * Read-only confirmation summary shown above the submit button: who the
 * message goes to, from which account, and when (in which timezone).
 * Date/time uses the existing formatDate helper; no new format function.
 */
export function ScheduleConfirmationSummary({
  recipient,
  device,
  scheduledAtLocal,
  timezone,
}: {
  recipient: string;
  device: RegistryDevice | null;
  scheduledAtLocal: string;
  timezone: string;
}) {
  const {lang, t} = useI18n();
  const account = resolveScheduleAccount(device);
  const dateTime = scheduledAtLocal ? formatDate(scheduledAtLocal, lang) : '—';
  const rows: Array<{label: string; value: string; dirLtr?: boolean}> = [
    {label: t.scheduled.summaryRecipient, value: recipient.trim() || '—', dirLtr: true},
    {
      label: t.scheduled.summaryAccount,
      value: account ? `${account.name} (${account.number})` : t.scheduled.accountUnknown,
    },
    {label: t.scheduled.summaryDateTime, value: dateTime},
    {label: t.scheduled.summaryTimezone, value: timezone || '—', dirLtr: true},
  ];
  return (
    <div
      data-testid="schedule-confirmation-summary"
      className="space-y-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm"
    >
      <p className="font-medium text-foreground">{t.scheduled.summaryTitle}</p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
            <dd
              className="min-w-0 truncate text-end font-medium text-foreground"
              dir={row.dirLtr ? 'ltr' : undefined}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
