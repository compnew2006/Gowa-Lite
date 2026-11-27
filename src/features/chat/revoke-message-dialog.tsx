import {Loader2, Trash2} from 'lucide-react';
import type {MessageInfo} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {useI18n} from '@/lib/i18n';

export function RevokeMessageDialog({message, isPending, onClose, onConfirm}: {
  message: MessageInfo;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (messageId: string) => void;
}) {
  const {t} = useI18n();

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isPending) onClose();
      }}
      title={t.chats.revokeConfirmTitle}
      description={t.chats.revokeConfirmDesc}
    >
      <div className="space-y-4">
        {(message.content || message.filename) && (
          <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground/90">
            <p className="line-clamp-3">
              {message.content || message.filename}
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={onClose}
          >
            {t.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => onConfirm(message.id)}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            <span>{t.chats.revokeMessage}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
