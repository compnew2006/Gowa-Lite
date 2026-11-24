import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bell,
  BellOff,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  Heart,
  ListPlus,
  MessageSquareDot,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import type {MuteDuration, UnifiedChat} from '@/api/types';
import {computeChatMenuPosition} from '@/features/chat/chat-menu-positioning';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export type ChatRowMenuAction =
  | {type: 'archive'; archived: boolean}
  | {type: 'mute'; duration: MuteDuration}
  | {type: 'pin'; pinned: boolean}
  | {type: 'unread'; unread: boolean}
  | {type: 'favourite'; favourite: boolean}
  | {type: 'add_to_list'}
  | {type: 'block'; blocked: boolean}
  | {type: 'clear'}
  | {type: 'delete'};

const MENU_EST_WIDTH = 228;
const MENU_EST_HEIGHT = 368;
const SUBMENU_EST_WIDTH = 176;
const SUBMENU_EST_HEIGHT = 140;

export function ChatRowMenu({
  open,
  chat,
  anchor,
  canWrite,
  canRevoke,
  onClose,
  onAction,
}: {
  open: boolean;
  chat: UnifiedChat | null;
  anchor: {x: number; y: number} | null;
  canWrite: boolean;
  canRevoke: boolean;
  onClose: () => void;
  onAction: (chat: UnifiedChat, action: ChatRowMenuAction) => void;
}) {
  const {isRtl, t} = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const muteRowRef = useRef<HTMLButtonElement>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const [menuDims, setMenuDims] = useState({width: MENU_EST_WIDTH, height: MENU_EST_HEIGHT});
  const [muteOffsetTop, setMuteOffsetTop] = useState(44);

  useEffect(() => {
    if (!open) {
      setMuteOpen(false);
    }
  }, [open, chat?.device_id, chat?.jid]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setMenuDims({width: Math.ceil(rect.width), height: Math.ceil(rect.height)});
    }
    if (muteRowRef.current) {
      setMuteOffsetTop(muteRowRef.current.offsetTop);
    }
  }, [open, chat?.device_id, chat?.jid, canWrite, canRevoke]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!menuRef.current) return;
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'),
      );
      if (items.length === 0) return;
      const activeIdx = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = items[(activeIdx + 1) % items.length];
        next?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = items[(activeIdx - 1 + items.length) % items.length];
        prev?.focus();
      }
    };
    const onScrollOrResize = () => onClose();

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, onClose]);

  if (!open || !chat || !anchor || typeof document === 'undefined') return null;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const pos = computeChatMenuPosition({
    anchorX: anchor.x,
    anchorY: anchor.y,
    menuWidth: menuDims.width,
    menuHeight: menuDims.height,
    viewportWidth,
    viewportHeight,
    isRtl,
    submenuWidth: SUBMENU_EST_WIDTH,
    submenuHeight: SUBMENU_EST_HEIGHT,
    muteItemTopOffset: muteOffsetTop,
  });

  const isArchived = Boolean(chat.archived);
  const isPinned = Boolean(chat.is_pinned);
  const isMuted = Boolean(
    chat.muted_until_ms && (chat.muted_until_ms === -1 || chat.muted_until_ms > Date.now()),
  );
  const hasUnread = (chat.unread_count ?? 0) > 0;
  const isFavourite = Boolean(chat.is_favourite);
  const isBlocked = Boolean(chat.is_blocked);

  const trigger = (action: ChatRowMenuAction) => {
    onClose();
    onAction(chat, action);
  };

  const SubChevron = isRtl ? ChevronLeft : ChevronRight;
  const rowBaseClass =
    'flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-start text-[13.5px] text-popover-foreground transition-colors hover:bg-muted/80 focus-visible:bg-muted/80 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45';
  const dangerRowClass =
    'flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-start text-[13.5px] text-popover-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45';

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t.chats.chatActionsMenu}
        style={{left: `${pos.left}px`, top: `${pos.top}px`}}
        className="fixed z-50 min-w-[224px] max-w-[260px] rounded-2xl border border-border/80 bg-popover py-1.5 text-popover-foreground shadow-[0_4px_20px_rgba(11,20,26,0.14)]"
      >
        {canWrite && (
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setMuteOpen(false)}
            onClick={() => trigger({type: 'archive', archived: !isArchived})}
            className={rowBaseClass}
          >
            {isArchived ? (
              <ArchiveRestore className="size-[17px] shrink-0 text-muted-foreground" />
            ) : (
              <Archive className="size-[17px] shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">
              {isArchived ? t.chats.unarchiveChat : t.chats.archiveChat}
            </span>
          </button>
        )}

        {isMuted ? (
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setMuteOpen(false)}
            onClick={() => trigger({type: 'mute', duration: 'unmute'})}
            className={rowBaseClass}
          >
            <Bell className="size-[17px] shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{t.chats.unmuteNotifications}</span>
          </button>
        ) : (
          <button
            ref={muteRowRef}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={muteOpen}
            onMouseEnter={() => setMuteOpen(true)}
            onClick={() => setMuteOpen((prev) => !prev)}
            className={cn(rowBaseClass, muteOpen && 'bg-muted/80')}
          >
            <BellOff className="size-[17px] shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{t.chats.muteNotifications}</span>
            <SubChevron className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}

        {canWrite && (
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setMuteOpen(false)}
            onClick={() => trigger({type: 'pin', pinned: !isPinned})}
            className={rowBaseClass}
          >
            {isPinned ? (
              <PinOff className="size-[17px] shrink-0 text-muted-foreground" />
            ) : (
              <Pin className="size-[17px] shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">
              {isPinned ? t.chats.unpinChat : t.chats.pinChat}
            </span>
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setMuteOpen(false)}
          onClick={() => trigger({type: 'unread', unread: !hasUnread})}
          className={rowBaseClass}
        >
          {hasUnread ? (
            <CheckCheck className="size-[17px] shrink-0 text-muted-foreground" />
          ) : (
            <MessageSquareDot className="size-[17px] shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate">
            {hasUnread ? t.chats.markAsRead : t.chats.markAsUnread}
          </span>
        </button>

        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setMuteOpen(false)}
          onClick={() => trigger({type: 'favourite', favourite: !isFavourite})}
          className={rowBaseClass}
        >
          <Heart
            className={cn(
              'size-[17px] shrink-0',
              isFavourite ? 'fill-rose-500 text-rose-500' : 'text-muted-foreground',
            )}
          />
          <span className="flex-1 truncate">
            {isFavourite ? t.chats.removeFromFavourites : t.chats.addToFavourites}
          </span>
        </button>

        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setMuteOpen(false)}
          onClick={() => trigger({type: 'add_to_list'})}
          className={rowBaseClass}
        >
          <ListPlus className="size-[17px] shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{t.chats.addToList}</span>
        </button>

        {(canWrite || canRevoke) && <div className="my-1.5 border-t border-border/70" />}

        {canWrite && (
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setMuteOpen(false)}
            onClick={() => trigger({type: 'block', blocked: !isBlocked})}
            className={dangerRowClass}
          >
            <Ban className="size-[17px] shrink-0 opacity-75" />
            <span className="flex-1 truncate">
              {isBlocked ? t.chats.unblockChat : t.chats.blockChat}
            </span>
          </button>
        )}

        {canRevoke && (
          <>
            <button
              type="button"
              role="menuitem"
              onMouseEnter={() => setMuteOpen(false)}
              onClick={() => trigger({type: 'clear'})}
              className={dangerRowClass}
            >
              <CircleMinus className="size-[17px] shrink-0 opacity-75" />
              <span className="flex-1 truncate">{t.chats.clearChat}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onMouseEnter={() => setMuteOpen(false)}
              onClick={() => trigger({type: 'delete'})}
              className={dangerRowClass}
            >
              <Trash2 className="size-[17px] shrink-0 opacity-75" />
              <span className="flex-1 truncate">{t.chats.deleteChat}</span>
            </button>
          </>
        )}
      </div>

      {!isMuted && muteOpen && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={t.chats.muteNotifications}
          style={{left: `${pos.submenuLeft}px`, top: `${pos.submenuTop}px`}}
          className="fixed z-50 min-w-[168px] rounded-2xl border border-border/80 bg-popover py-1.5 text-popover-foreground shadow-[0_4px_20px_rgba(11,20,26,0.14)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => trigger({type: 'mute', duration: '8h'})}
            className={rowBaseClass}
          >
            <span>{t.chats.mute8Hours}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => trigger({type: 'mute', duration: '1w'})}
            className={rowBaseClass}
          >
            <span>{t.chats.mute1Week}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => trigger({type: 'mute', duration: 'always'})}
            className={rowBaseClass}
          >
            <span>{t.chats.muteAlways}</span>
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}
