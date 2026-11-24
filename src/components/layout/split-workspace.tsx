import type {CSSProperties, ComponentType, ReactNode} from 'react';
import {useRef} from 'react';
import {RefreshCw, Settings, Smartphone} from 'lucide-react';
import {Link} from 'react-router-dom';
import type {ApiError} from '@/api/types';
import {Button} from '@/components/ui/button';
import {useResizableSidebar} from '@/hooks/use-resizable-sidebar';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function isGowaConnectionError(apiErr: ApiError | null | undefined): boolean {
  return Boolean(
    apiErr && (apiErr.code === 'GOWA_NOT_CONFIGURED' || apiErr.code === 'GOWA_UNREACHABLE'),
  );
}

export function GowaSetupNotice({
  apiErr,
  isAdmin,
  onRetry,
}: {
  apiErr: ApiError;
  isAdmin: boolean;
  onRetry: () => void;
}) {
  const {t} = useI18n();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Smartphone className="size-5" />
        </div>
        <h1 className="text-base font-semibold text-foreground">
          {apiErr.code === 'GOWA_NOT_CONFIGURED'
            ? t.chats.gowaNotConfiguredTitle
            : t.chats.gowaUnreachableTitle}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {apiErr.code === 'GOWA_NOT_CONFIGURED' ? t.chats.gowaNotConfiguredDesc : apiErr.message}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {isAdmin && (
            <Link
              to="/settings"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 whitespace-nowrap"
            >
              <Settings className="size-3.5" />
              <span>{t.chats.goToSettings}</span>
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            <span>{t.retry}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceEmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: ComponentType<{className?: string}>;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="wa-wallpaper flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-card/90 text-primary shadow-sm">
        <Icon className="size-7" />
      </div>
      <p className="text-base font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export function SplitWorkspace({
  storageKey,
  showDetailOnMobile,
  sidebar,
  detail,
  emptyState,
  detailClassName = 'bg-chat-canvas',
  active = true,
}: {
  storageKey: string;
  showDetailOnMobile: boolean;
  sidebar: ReactNode;
  detail: ReactNode | null;
  emptyState?: ReactNode;
  detailClassName?: string;
  active?: boolean;
}) {
  const {isRtl, t} = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    sidebarWidth,
    minSidebarWidth,
    maxSidebarWidth,
    isResizing,
    handleResizePointerDown,
    handleResetSidebarWidth,
    handleResizeKeyDown,
  } = useResizableSidebar({
    storageKey,
    isRtl,
    active,
    containerRef,
  });

  return (
    <div
      ref={containerRef}
      style={{'--chat-sidebar-width': `${sidebarWidth}px`} as CSSProperties}
      className="flex h-full min-h-0 flex-col lg:flex-row"
    >
      <section
        className={cn(
          'relative h-full min-h-0 w-full border-e border-border bg-card lg:w-[var(--chat-sidebar-width)] lg:shrink-0',
          showDetailOnMobile ? 'hidden lg:block lg:flex-none' : 'block flex-1 lg:flex-none',
        )}
      >
        {sidebar}

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t.chats.resizeSidebarAria}
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          title={t.chats.resizeSidebarTitle}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onDoubleClick={handleResetSidebarWidth}
          onKeyDown={handleResizeKeyDown}
          className="group absolute inset-y-0 -end-[4px] z-20 hidden w-[8px] cursor-col-resize touch-none items-center justify-center focus-visible:outline-none lg:flex"
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-full w-[3px] rounded-full transition-colors',
              isResizing
                ? 'bg-primary'
                : 'bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary',
            )}
          />
        </div>
      </section>

      <section
        className={cn(
          'h-full min-h-0 min-w-0 flex-1',
          detailClassName,
          showDetailOnMobile ? 'block' : 'hidden lg:block',
        )}
      >
        {detail ?? emptyState}
      </section>
    </div>
  );
}
