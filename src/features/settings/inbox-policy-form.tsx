import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, Save} from 'lucide-react';
import {toast} from 'sonner';
import {getInboxPolicy, saveInboxPolicy} from '@/api/requests/settings';
import type {ClosedReplyPolicy, UnassignedReplyPolicy} from '@/api/types';
import {Button} from '@/components/ui/button';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function InboxPolicyForm({canWrite}: {canWrite: boolean}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [unassignedPolicy, setUnassignedPolicy] = useState<UnassignedReplyPolicy>('auto_claim');
  const [closedPolicy, setClosedPolicy] = useState<ClosedReplyPolicy>('block');

  const policyQuery = useQuery({
    queryKey: ['inbox-policy'],
    queryFn: getInboxPolicy,
  });

  useEffect(() => {
    if (policyQuery.data) {
      setUnassignedPolicy(policyQuery.data.unassigned_reply_policy);
      setClosedPolicy(policyQuery.data.closed_reply_policy);
    }
  }, [policyQuery.data]);

  const savePolicyMutation = useMutation({
    mutationFn: () =>
      saveInboxPolicy({
        unassigned_reply_policy: unassignedPolicy,
        closed_reply_policy: closedPolicy,
      }),
    onSuccess: () => {
      toast.success(t.settings.policySavedToast);
      void queryClient.invalidateQueries({queryKey: ['inbox-policy']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const handlePolicySubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    savePolicyMutation.mutate();
  };

  const unassignedOptions: Array<{
    value: UnassignedReplyPolicy;
    title: string;
    desc: string;
  }> = [
    {
      value: 'auto_claim',
      title: t.settings.unassignedAutoClaimTitle,
      desc: t.settings.unassignedAutoClaimDesc,
    },
    {
      value: 'require_claim',
      title: t.settings.unassignedRequireClaimTitle,
      desc: t.settings.unassignedRequireClaimDesc,
    },
    {
      value: 'allow_without_claim',
      title: t.settings.unassignedAllowTitle,
      desc: t.settings.unassignedAllowDesc,
    },
  ];

  const closedOptions: Array<{
    value: ClosedReplyPolicy;
    title: string;
    desc: string;
  }> = [
    {
      value: 'block',
      title: t.settings.closedBlockTitle,
      desc: t.settings.closedBlockDesc,
    },
    {
      value: 'reopen_and_claim',
      title: t.settings.closedReopenTitle,
      desc: t.settings.closedReopenDesc,
    },
  ];

  return (
    <form
      onSubmit={handlePolicySubmit}
      className="flex max-w-2xl flex-col gap-5 rounded-xl border border-border bg-card p-6"
    >
      <div>
        <h2 className="text-base font-bold text-foreground">{t.settings.inboxPolicyTitle}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t.settings.inboxPolicySubtitle}</p>
      </div>

      <fieldset disabled={!canWrite} className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-foreground">
          {t.settings.unassignedReplyLabel}
        </legend>
        {unassignedOptions.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 transition-colors ${
              unassignedPolicy === opt.value
                ? 'border-primary/60 bg-accent/50'
                : 'border-border hover:bg-muted/40'
            } ${!canWrite ? 'cursor-default opacity-80' : ''}`}
          >
            <input
              type="radio"
              name="unassigned_reply_policy"
              value={opt.value}
              checked={unassignedPolicy === opt.value}
              onChange={() => setUnassignedPolicy(opt.value)}
              className="mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">{opt.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {opt.desc}
              </p>
            </div>
          </label>
        ))}
      </fieldset>

      <fieldset disabled={!canWrite} className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-semibold text-foreground">
          {t.settings.closedReplyLabel}
        </legend>
        {closedOptions.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 transition-colors ${
              closedPolicy === opt.value
                ? 'border-primary/60 bg-accent/50'
                : 'border-border hover:bg-muted/40'
            } ${!canWrite ? 'cursor-default opacity-80' : ''}`}
          >
            <input
              type="radio"
              name="closed_reply_policy"
              value={opt.value}
              checked={closedPolicy === opt.value}
              onChange={() => setClosedPolicy(opt.value)}
              className="mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">{opt.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {opt.desc}
              </p>
            </div>
          </label>
        ))}
      </fieldset>

      {canWrite && (
        <div className="flex justify-end border-t border-border pt-4">
          <Button
            type="submit"
            disabled={savePolicyMutation.isPending || policyQuery.isLoading}
          >
            {savePolicyMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            <span>{t.settings.savePolicyBtn}</span>
          </Button>
        </div>
      )}
    </form>
  );
}
