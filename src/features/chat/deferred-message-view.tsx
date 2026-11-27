import {useEffect, useState, type ComponentProps} from 'react';
import {Loader2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {MessageView} from '@/features/chat/message-view';
import {useI18n} from '@/lib/i18n';

let loadedView: typeof MessageView | undefined;
let viewRequest: Promise<typeof MessageView> | undefined;

export function DeferredMessageView(props: ComponentProps<typeof MessageView>) {
  const {t} = useI18n();
  const [View, setView] = useState(() => loadedView);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (View || failed) return;
    let active = true;
    viewRequest ??= import('@/features/chat/message-view').then((module) => {
      loadedView = module.MessageView;
      return loadedView;
    }).catch((error: unknown) => {
      viewRequest = undefined;
      throw error;
    });
    void viewRequest.then((component) => {
      if (active) setView(() => component);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [View, failed]);

  if (View) return <View {...props} />;
  if (failed) {
    return (
      <div className="flex h-full items-center justify-center">
        <Button variant="outline" onClick={() => setFailed(false)}>{t.retry}</Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{t.chats.loadingMessages}</span>
    </div>
  );
}
