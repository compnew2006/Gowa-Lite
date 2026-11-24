import {useEffect, useState, type FormEvent} from 'react';
import {AlertTriangle, MessagesSquare} from 'lucide-react';
import type {AccountSummary} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {useI18n} from '@/lib/i18n';
import {toWhatsAppJid} from '@/lib/phone';

export function NewChatDialog({
  open,
  onOpenChange,
  accounts,
  defaultDeviceId,
  onStartChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountSummary[];
  defaultDeviceId?: string;
  onStartChat: (deviceId: string, jid: string) => void;
}) {
  const {t} = useI18n();
  const [deviceId, setDeviceId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const preferred =
      (defaultDeviceId && accounts.find((a) => a.id === defaultDeviceId)?.id) ||
      accounts.find((a) => a.state === 'logged_in')?.id ||
      accounts[0]?.id ||
      '';
    setDeviceId(preferred);
    setRecipient('');
    setError(null);
  }, [accounts, defaultDeviceId, open]);

  const selectedAccount = accounts.find((a) => a.id === deviceId);
  const isSelectedOffline = Boolean(selectedAccount && selectedAccount.state !== 'logged_in');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!deviceId) return;
    const jid = toWhatsAppJid(recipient);
    if (!jid) {
      setError(t.chats.newChatInvalidRecipient);
      return;
    }
    onStartChat(deviceId, jid);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.chats.newChatTitle}
      description={t.chats.newChatDesc}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-chat-account">{t.chats.newChatAccountLabel}</Label>
          <select
            id="new-chat-account"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            disabled={accounts.length === 0}
            className="flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {accounts.length === 0 ? (
              <option value="">{t.chats.noAccountsAvailable}</option>
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

        <div className="space-y-1.5">
          <Label htmlFor="new-chat-recipient">{t.chats.newChatRecipientLabel}</Label>
          <Input
            id="new-chat-recipient"
            dir="ltr"
            autoFocus
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value);
              if (error) setError(null);
            }}
            placeholder={t.chats.newChatRecipientPlaceholder}
            required
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {isSelectedOffline && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t.chats.newChatNoConnectedAccounts}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={!deviceId || !recipient.trim()}>
            <MessagesSquare className="size-4" />
            <span>{t.chats.newChatOpenBtn}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
