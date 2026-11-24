import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

const DEFAULT_SIDEBAR_WIDTH = 390;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 640;
const MIN_CONVERSATION_WIDTH = 320;

function clampSidebarWidth(width: number, containerWidth?: number): number {
  const dynamicMax =
    containerWidth && containerWidth > 0
      ? Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, containerWidth - MIN_CONVERSATION_WIDTH),
        )
      : MAX_SIDEBAR_WIDTH;
  return Math.round(Math.min(dynamicMax, Math.max(MIN_SIDEBAR_WIDTH, width)));
}

export function useResizableSidebar({
  storageKey,
  isRtl,
  active,
  containerRef,
}: {
  storageKey: string;
  isRtl: boolean;
  active: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) {
          return clampSidebarWidth(parsed);
        }
      }
    } catch {
      // ignore storage access errors
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });
  const [maxSidebarWidth, setMaxSidebarWidth] = useState(MAX_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      // ignore storage access errors
    }
  }, [storageKey, sidebarWidth]);

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (!el) return;
    const updateBounds = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const nextMax = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, width - MIN_CONVERSATION_WIDTH),
      );
      setMaxSidebarWidth(nextMax);
      setSidebarWidth((prev) => Math.min(nextMax, Math.max(MIN_SIDEBAR_WIDTH, prev)));
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, containerRef]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    cleanupDragRef.current?.();

    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const containerWidth = containerRef.current?.clientWidth;

    setIsResizing(true);
    document.body.classList.add('select-none');
    document.body.style.cursor = 'col-resize';

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const rawWidth = isRtl ? startWidth - deltaX : startWidth + deltaX;
      setSidebarWidth(clampSidebarWidth(rawWidth, containerWidth));
    };

    const cleanup = () => {
      cleanupDragRef.current = null;
      setIsResizing(false);
      document.body.classList.remove('select-none');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleResetSidebarWidth = () => {
    const containerWidth = containerRef.current?.clientWidth;
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, containerWidth));
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    const containerWidth = containerRef.current?.clientWidth;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = isRtl ? step : -step;
      setSidebarWidth((prev) => clampSidebarWidth(prev + delta, containerWidth));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = isRtl ? -step : step;
      setSidebarWidth((prev) => clampSidebarWidth(prev + delta, containerWidth));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSidebarWidth(clampSidebarWidth(MAX_SIDEBAR_WIDTH, containerWidth));
    }
  };

  return {
    sidebarWidth,
    minSidebarWidth: MIN_SIDEBAR_WIDTH,
    maxSidebarWidth,
    isResizing,
    handleResizePointerDown,
    handleResetSidebarWidth,
    handleResizeKeyDown,
  };
}
