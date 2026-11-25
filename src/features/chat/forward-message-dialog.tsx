import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {AlertTriangle, Forward, Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {DEFAULT_UNIFIED_CHATS_QUERY_KEY, forwardUnifiedMessage, listUnifiedChats} from '@/api/client';
import type {MessageInfo} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {chatDisplayName, formatJidPhone} from '@/features/chat/display-name';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toWhatsAppJid} from '@/lib/phone';

export function ForwardMessageDialog({
  open,
  onOpenChange,
  message,
  sourceDeviceId,
  sourceChatJid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: MessageInfo | null;
  sourceDeviceId: string;
  sourceChatJid: string;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();

  const [targetDeviceId, setTargetDeviceId] = useState(sourceDeviceId);
  const [recipient, setRecipient] = useState('');
  const [selectedRecentJid, setSelectedRecentJid] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chatsQuery = useQuery({
    queryKey: DEFAULT_UNIFIED_CHATS_QUERY_KEY,
    queryFn: () => listUnifiedChats({}),
    enabled: open,
    staleTime: 20_000,
  });

  const accounts = useMemo(() => chatsQuery.data?.accounts ?? [], [chatsQuery.data?.accounts]);
  const recentChats = useMemo(
    () =>
      (chatsQuery.data?.data ?? []).filter(
        (c) => c.device_id === targetDeviceId && !(c.device_id === sourceDeviceId && c.jid === sourceChatJid),
      ),
    [chatsQuery.data?.data, sourceChatJid, sourceDeviceId, targetDeviceId],
  );

  useEffect(() => {
    if (!open) return;
    const sourceAcc = accounts.find((a) => a.id === sourceDeviceId);
    const preferred =
      (sourceAcc && sourceAcc.state === 'logged_in' ? sourceAcc.id : undefined) ||
      accounts.find((a) => a.state === 'logged_in')?.id ||
      sourceDeviceId;
    setTargetDeviceId(preferred);
    setRecipient('');
    setSelectedRecentJid('');
    setError(null);
  }, [accounts, open, sourceDeviceId]);

  const selectedAccount = accounts.find((a) => a.id === targetDeviceId);
  const isTargetOffline = Boolean(selectedAccount && selectedAccount.state !== 'logged_in');

  const forwardMutation = useMutation({
    mutationFn: (payload: {targetDeviceId: string; targetJid: string}) => {
      if (!message) throw new Error('No message selected');
      return forwardUnifiedMessage(sourceDeviceId, sourceChatJid, message.id, {
        target_device_id: payload.targetDeviceId,
        target_jid: payload.targetJid,
        content: message.content,
        media_type: message.media_type,
        filename: message.filename,
        url: message.url,
      });
    },
    onSuccess: (_res, vars) => {
      toast.success(t.chats.forwardedToast);
      void queryClient.invalidateQueries({
        queryKey: ['unified-messages', vars.targetDeviceId, vars.targetJid],
      });
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!message || !targetDeviceId || forwardMutation.isPending) return;
    const jid = toWhatsAppJid(recipient);
    if (!jid || jid.endsWith('@newsletter')) {
      setError(t.chats.forwardInvalidRecipient);
      return;
    }
    forwardMutation.mutate({targetDeviceId, targetJid: jid});
  };

  const previewText = message
    ? message.content?.trim() ||
      message.filename ||
      t.chats.mediaLabels[message.media_type] ||
      t.messageFallback
    : '';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.chats.forwardTitle}
      description={t.chats.forwardDesc}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {previewText && (
          <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
            <p className="line-clamp-3 text-foreground/90">{previewText}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="forward-account">{t.chats.forwardTargetAccount}</Label>
          <select
            id="forward-account"
            value={targetDeviceId}
            onChange={(event) => {
              setTargetDeviceId(event.target.value);
              setSelectedRecentJid('');
            }}
            disabled={accounts.length === 0 || forwardMutation.isPending}
            className="flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {accounts.length === 0 ? (
              <option value={sourceDeviceId}>{sourceDeviceId}</option>
            ) : (
              accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.display_name}
                  {acc.state !== 'logged_in' ? ` ${t.chats.offlineTag}` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        {recentChats.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="forward-recent-chat">{t.chats.forwardRecentChatsLabel}</Label>
            <select
              id="forward-recent-chat"
              value={selectedRecentJid}
              onChange={(event) => {
                const jid = event.target.value;
                setSelectedRecentJid(jid);
                if (jid) {
                  setRecipient(jid);
                  if (error) setError(null);
                }
              }}
              disabled={forwardMutation.isPending}
              className="flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              <option value="">{t.chats.forwardSelectChatPlaceholder}</option>
              {recentChats.map((chat) => {
                const label = chatDisplayName(chat);
                const phone = formatJidPhone(chat.jid);
                return (
                  <option key={`${chat.device_id}::${chat.jid}`} value={chat.jid}>
                    {phone && phone !== label ? `${label} (${phone})` : label}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="forward-recipient">{t.chats.forwardTargetRecipient}</Label>
          <Input
            id="forward-recipient"
            dir="ltr"
            autoFocus
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value);
              setSelectedRecentJid('');
              if (error) setError(null);
            }}
            placeholder={t.chats.forwardRecipientPlaceholder}
            disabled={forwardMutation.isPending}
            required
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {isTargetOffline && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t.chats.accountCurrentlyOffline}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={forwardMutation.isPending}
          >
            {t.cancel}
          </Button>
          <Button
            type="submit"
            disabled={!targetDeviceId || !recipient.trim() || isTargetOffline || forwardMutation.isPending}
          >
            {forwardMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Forward className="size-4" />
            )}
            <span>{t.chats.forwardSubmit}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
