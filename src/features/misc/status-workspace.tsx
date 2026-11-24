import {
  ArrowLeft,
  ArrowRight,
  CircleDashed,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Video,
} from 'lucide-react';
import {Link} from 'react-router-dom';
import type {UnifiedStatusAccountSummary, UnifiedStatusItem} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {accountDotTone, shortAccountWidgetLabel} from '@/features/chat/chat-list';
import {formatJidPhone} from '@/features/chat/display-name';
import {MessageMedia} from '@/features/chat/message-media';
import type {StatusContactGroup} from '@/features/misc/status-helpers';
import {formatDate, formatShortTime} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

function statusMediaIcon(mediaType: string) {
  switch ((mediaType || '').toLowerCase()) {
    case 'image':
    case 'sticker':
      return ImageIcon;
    case 'video':
      return Video;
    case 'audio':
    case 'ptt':
      return Mic;
    case 'document':
    case 'file':
      return FileText;
    default:
      return CircleDashed;
  }
}

export function StatusAccountFilterBar({
  accounts,
  selectedAccountId,
  onSelectAccount,
}: {
  accounts: UnifiedStatusAccountSummary[];
  selectedAccountId: string;
  onSelectAccount: (deviceId: string) => void;
}) {
  const {t} = useI18n();
  if (accounts.length === 0) return null;

  const onlineCount = accounts.filter(
    (a) => a.state === 'logged_in' || a.state === 'connected',
  ).length;
  const totalStatuses = accounts.reduce((sum, a) => sum + a.status_count, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{t.misc.accountsOverviewConnected(onlineCount, accounts.length)}</span>
        <span className="font-medium tabular-nums">{t.misc.statusesCount(totalStatuses)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelectAccount('all')}
          className={cn(
            'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
            selectedAccountId === 'all'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground hover:text-foreground',
          )}
        >
          <span>{t.misc.allAccounts}</span>
          <span className="tabular-nums opacity-80">{totalStatuses}</span>
        </button>

        {accounts.map((acc) => {
          const isOnline = acc.state === 'logged_in' || acc.state === 'connected';
          const active = selectedAccountId === acc.id;
          return (
            <button
              key={acc.id}
              type="button"
              onClick={() => onSelectAccount(acc.id)}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
                !isOnline && !active && 'opacity-65',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  isOnline ? accountDotTone(acc.id) : 'bg-muted-foreground/50',
                )}
              />
              <span className="max-w-[120px] truncate">
                {shortAccountWidgetLabel(acc.display_name)}
              </span>
              <span className="tabular-nums opacity-80">{acc.status_count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StatusGroupList({
  groups,
  totalGroupsCount,
  isLoading,
  error,
  deviceErrors,
  selectedGroupKey,
  onSelectGroup,
}: {
  groups: StatusContactGroup[];
  totalGroupsCount: number;
  isLoading: boolean;
  error: unknown;
  deviceErrors: Array<{device_id: string; display_name: string; message: string}>;
  selectedGroupKey: string | null;
  onSelectGroup: (key: string) => void;
}) {
  const {lang, t} = useI18n();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{t.loading}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-xs text-destructive">
        {toApiError(error).message}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {deviceErrors.length > 0 && (
        <div className="mx-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          {deviceErrors.map((err) => (
            <p key={err.device_id} className="truncate">
              {err.display_name}: {err.message}
            </p>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          {totalGroupsCount === 0 ? t.misc.noStatuses : t.misc.noMatchingStatuses}
        </div>
      ) : (
        <ul className="space-y-0.5">
          {groups.map((group) => {
            const latest = group.items[0];
            const isSelected = selectedGroupKey === group.key;
            const mediaLabel =
              latest?.media_type && latest.media_type !== 'text'
                ? t.chats.mediaLabels[latest.media_type] || latest.media_type
                : '';
            const preview =
              latest?.content?.trim() || mediaLabel || t.misc.textStatusLabel;

            return (
              <li key={group.key}>
                <button
                  type="button"
                  onClick={() => onSelectGroup(group.key)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
                    isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
                  )}
                >
                  <ContactAvatar
                    deviceId={group.device_id}
                    jid={group.sender_jid || group.device_id}
                    name={group.sender_display_name}
                    sizeClass="size-11"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[14.5px] font-medium text-foreground">
                        {group.sender_display_name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {formatShortTime(group.latest_timestamp, lang)}
                      </span>
                    </div>

                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{preview}</p>

                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground/85">
                        <span
                          aria-hidden="true"
                          className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(group.device_id))}
                        />
                        <span className="truncate">
                          {shortAccountWidgetLabel(group.device_display_name)}
                        </span>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 tabular-nums">
                        {t.misc.statusesCount(group.items.length)}
                      </span>
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusItemCard({item}: {item: UnifiedStatusItem}) {
  const {lang, t} = useI18n();
  const normalizedMediaType = (item.media_type || '').trim().toLowerCase();
  const hasMedia = Boolean(
    normalizedMediaType && normalizedMediaType !== 'text' && normalizedMediaType !== 'revoked',
  );
  const Icon = statusMediaIcon(normalizedMediaType);
  const typeLabel = hasMedia
    ? t.chats.mediaLabels[normalizedMediaType] || normalizedMediaType
    : t.misc.textStatusLabel;

  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Icon className="size-3.5 text-primary" />
          <span>{typeLabel}</span>
        </span>
        <time dateTime={item.timestamp} className="tabular-nums">
          {formatDate(item.timestamp, lang)}
        </time>
      </header>

      {hasMedia && (
        <div className="mt-2">
          <MessageMedia
            deviceId={item.device_id}
            message={{
              id: item.id,
              chat_jid: 'status@broadcast',
              sender_jid: item.sender_jid,
              content: item.content,
              timestamp: item.timestamp,
              is_from_me: item.is_from_me,
              media_type: item.media_type,
              filename: item.filename,
              url: item.url,
              file_length: item.file_length,
            }}
          />
        </div>
      )}

      {item.content?.trim() && (
        <p
          dir="auto"
          className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
        >
          {item.content}
        </p>
      )}
    </article>
  );
}

export function StatusDetailPanel({
  group,
  onBack,
}: {
  group: StatusContactGroup;
  onBack: () => void;
}) {
  const {lang, t} = useI18n();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const senderPhone = formatJidPhone(group.sender_jid);
  const canOpenChat =
    Boolean(group.sender_jid) &&
    group.sender_jid.includes('@') &&
    group.sender_jid.toLowerCase() !== 'status@broadcast';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t.misc.backToStatuses}
            aria-label={t.misc.backToStatuses}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <BackIcon className="size-4" />
          </button>

          <ContactAvatar
            deviceId={group.device_id}
            jid={group.sender_jid || group.device_id}
            name={group.sender_display_name}
            sizeClass="size-10"
            eager
          />

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {group.sender_display_name}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground/90">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(group.device_id))}
                />
                <span className="truncate">
                  {shortAccountWidgetLabel(group.device_display_name)}
                </span>
              </span>
              {senderPhone && (
                <>
                  <span aria-hidden="true">·</span>
                  <span dir="ltr" className="font-mono tabular-nums">
                    {senderPhone}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{t.misc.statusesCount(group.items.length)}</span>
            </div>
          </div>
        </div>

        {canOpenChat && (
          <Link
            to={`/chats?device=${encodeURIComponent(group.device_id)}&jid=${encodeURIComponent(group.sender_jid)}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-xs font-medium whitespace-nowrap text-foreground transition-colors hover:bg-secondary/80"
          >
            <MessageSquare className="size-3.5" />
            <span>{t.misc.openSenderChat}</span>
          </Link>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-2xl space-y-3">
          {group.items.map((item) => (
            <StatusItemCard key={`${item.device_id}::${item.id}`} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}
