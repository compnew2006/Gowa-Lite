import {Languages} from 'lucide-react';
import {updateMyPreferences} from '@/api/client';
import {Button} from '@/components/ui/button';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

export function LanguageToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const {lang, t} = useI18n();
  const status = useAuthStore((s) => s.status);
  const setLanguageLocal = useAuthStore((s) => s.setLanguageLocal);

  const handleToggle = () => {
    const nextLang = lang === 'ar' ? 'en' : 'ar';
    setLanguageLocal(nextLang);
    if (status === 'authenticated') {
      void updateMyPreferences({language: nextLang}).catch(() => undefined);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleToggle}
        title={t.switchLanguageTitle}
        aria-label={t.switchLanguageTitle}
        className={cn(
          'flex size-10 cursor-pointer items-center justify-center rounded-full text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
      >
        {lang === 'ar' ? 'EN' : 'ع'}
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleToggle}
      title={t.switchLanguageTitle}
      aria-label={t.switchLanguageTitle}
      className={className}
    >
      <Languages className="size-3.5 shrink-0" />
      <span>{t.switchLanguageLabel}</span>
    </Button>
  );
}
