import {useEffect, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {fetchContactAvatarBlob} from '@/api/client';
import {cn} from '@/lib/utils';

const AVATAR_TONES = [
  'bg-emerald-600/20 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-sky-600/20 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  'bg-amber-600/20 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-teal-600/20 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300',
  'bg-indigo-600/20 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
];

export function avatarToneClass(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

export function ContactAvatar({
  deviceId,
  jid,
  name,
  sizeClass = 'size-10',
  textClass = 'text-sm',
  className,
  eager = false,
}: {
  deviceId: string;
  jid: string;
  name?: string | null;
  sizeClass?: string;
  textClass?: string;
  className?: string;
  eager?: boolean;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(
    () => eager || typeof IntersectionObserver === 'undefined',
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const normalizedJid = jid.trim();
  const canFetch = Boolean(
    deviceId && normalizedJid && normalizedJid !== 'status@broadcast',
  );

  useEffect(() => {
    if (eager) {
      setInView(true);
      return;
    }
    if (inView || !canFetch || typeof IntersectionObserver === 'undefined') return;
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      {rootMargin: '160px'},
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, inView, canFetch]);

  const avatarQuery = useQuery({
    queryKey: ['contact-avatar', deviceId, normalizedJid],
    queryFn: () => fetchContactAvatarBlob(deviceId, normalizedJid),
    enabled: inView && canFetch,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  });

  useEffect(() => {
    setImgFailed(false);
    const blob = avatarQuery.data;
    if (!blob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [avatarQuery.data]);

  const label = (name?.trim() || normalizedJid || '?').replace(/^\+/, '');
  const initial = label.slice(0, 1).toUpperCase() || '?';

  return (
    <span
      ref={containerRef}
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none',
        sizeClass,
        textClass,
        (!objectUrl || imgFailed) && avatarToneClass(name || normalizedJid || '?'),
        className,
      )}
    >
      {objectUrl && !imgFailed ? (
        <img
          src={objectUrl}
          alt={name?.trim() || normalizedJid}
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        initial
      )}
    </span>
  );
}
