import {CheckCircle2, Hand, RotateCcw, UserCheck, UserMinus, X} from 'lucide-react';
import type {UnifiedChatTab} from '@/api/types';
import type {BulkLifecycleAction} from '@/features/chat/use-inbox-controller';
import {useI18n} from '@/lib/i18n';

/**
 * The bulk action bar shown above the chat list while bulk-select mode is on.
 * Extracted from ChatList so the bar is directly testable (P1-5).
 *
 * P1-5: "Claim selected" calls the same bulk-lifecycle endpoint with the
 * `assign` action; the controller attaches assigned_user_id = the current
 * user. P2-8: "Assign selected" opens the agent picker and assigns the
 * selection to the chosen agent instead. Claiming only makes sense for
 * pending chats (and `all`, which contains them) — the same scope as the
 * single-chat claim button; assigning to another agent also covers open
 * chats (transfers, enforced per chat server-side).
 */
export function BulkActionBar({
  selectedCount,
  activeTab,
  canAssign,
  canClose,
  isBulkPending,
  onRunBulk,
  onOpenBulkAssign,
  onSelectAllVisible,
  onCancel,
}: {
  selectedCount: number;
  activeTab?: UnifiedChatTab;
  canAssign: boolean;
  canClose: boolean;
  isBulkPending: boolean;
  onRunBulk: (action: BulkLifecycleAction) => void;
  onOpenBulkAssign?: () => void;
  onSelectAllVisible: () => void;
  onCancel: () => void;
}) {
  const {t} = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-border bg-secondary/70 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-foreground tabular-nums">
          {t.chats.bulkSelectedCount(selectedCount)}
        </span>
        <button
          type="button"
          onClick={onSelectAllVisible}
          className="cursor-pointer font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t.chats.bulkSelectAllVisible}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {canAssign && (activeTab === 'pending' || activeTab === 'all') && (
          <button
            type="button"
            disabled={selectedCount === 0 || isBulkPending}
            onClick={() => onRunBulk('assign')}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring whitespace-nowrap"
          >
            <Hand className="size-3" />
            <span>{t.chats.bulkClaimBtn}</span>
          </button>
        )}
        {canAssign && onOpenBulkAssign && activeTab !== 'closed' && (
          <button
            type="button"
            disabled={selectedCount === 0 || isBulkPending}
            onClick={onOpenBulkAssign}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring whitespace-nowrap"
          >
            <UserCheck className="size-3" />
            <span>{t.chats.bulkAssignBtn}</span>
          </button>
        )}
        {canClose && activeTab !== 'closed' && (
          <button
            type="button"
            disabled={selectedCount === 0 || isBulkPending}
            onClick={() => onRunBulk('close')}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring whitespace-nowrap"
          >
            <CheckCircle2 className="size-3" />
            <span>{t.chats.bulkCloseBtn}</span>
          </button>
        )}
        {canAssign && (activeTab === 'me' || activeTab === 'open' || activeTab === 'all') && (
          <button
            type="button"
            disabled={selectedCount === 0 || isBulkPending}
            onClick={() => onRunBulk('release')}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring whitespace-nowrap"
          >
            <UserMinus className="size-3" />
            <span>{t.chats.bulkReleaseBtn}</span>
          </button>
        )}
        {canClose && activeTab === 'closed' && (
          <button
            type="button"
            disabled={selectedCount === 0 || isBulkPending}
            onClick={() => onRunBulk('reopen')}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring whitespace-nowrap"
          >
            <RotateCcw className="size-3" />
            <span>{t.chats.bulkReopenBtn}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          aria-label={t.chats.bulkCancelSelect}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
