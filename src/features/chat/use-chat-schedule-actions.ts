import {useMemo, useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {actionUnifiedChatSchedule, updateUnifiedChatSchedule} from '@/api/client';
import type {ScheduleStatus, ScheduledSend, UnifiedChat} from '@/api/types';
import {
  minScheduleDateTimeLocal,
  toLocalDateTimeInput,
  validateScheduleFutureMs,
} from '@/features/schedules/schedule-utils';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

/**
 * Shared edit-time / pause / resume / cancel logic for one chat's schedules.
 * Used by the schedules drawer and by the scheduled bubble in the chat
 * timeline — both hit the same PATCH + action routes, so a fix here fixes
 * both surfaces.
 */
export function useChatScheduleActions(chat: UnifiedChat) {
  const {t} = useI18n();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const invalidateSchedules = () => {
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({queryKey: ['schedules', chat.device_id]});
  };

  const actionMutation = useMutation({
    mutationFn: ({id, action}: {id: string; action: 'pause' | 'resume' | 'cancel'}) =>
      actionUnifiedChatSchedule(chat.device_id, chat.jid, id, action),
    onSuccess: (_data, vars) => {
      if (vars.action === 'pause') toast.success(t.scheduled.pausedToast);
      else if (vars.action === 'resume') toast.success(t.scheduled.resumedToast);
      else {
        toast.success(t.scheduled.cancelledToast);
        setConfirmCancelId(null);
      }
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateTimeMutation = useMutation({
    mutationFn: ({id, scheduledAt}: {id: string; scheduledAt: string}) =>
      updateUnifiedChatSchedule(chat.device_id, chat.jid, id, {scheduled_at: scheduledAt}),
    onSuccess: () => {
      toast.success(t.chats.scheduleUpdatedToast);
      setEditingId(null);
      setEditingTime('');
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const statusLabels = useMemo<Record<ScheduleStatus, string>>(
    () => ({
      active: t.scheduled.statusActive,
      running: t.scheduled.statusRunning,
      paused: t.scheduled.statusPaused,
      completed: t.scheduled.statusCompleted,
      failed: t.scheduled.statusFailed,
      cancelled: t.scheduled.statusCancelled,
    }),
    [t],
  );

  const recurrenceLabels: Record<string, string> = {
    once: t.scheduled.recurrenceOnce,
    daily: t.scheduled.recurrenceDaily,
    weekly: t.scheduled.recurrenceWeekly,
    monthly: t.scheduled.recurrenceMonthly,
  };

  const startEditing = (item: ScheduledSend) => {
    const rawDate = item.next_run_at || item.scheduled_at;
    const parsed = rawDate ? new Date(rawDate) : new Date(Date.now() + 5 * 60_000);
    setConfirmCancelId(null);
    setEditingId(item.id);
    setEditingTime(
      toLocalDateTimeInput(
        Number.isNaN(parsed.getTime()) ? new Date(Date.now() + 5 * 60_000) : parsed,
      ),
    );
  };

  const saveTime = (id: string) => {
    try {
      const ms = validateScheduleFutureMs(editingTime);
      updateTimeMutation.mutate({id, scheduledAt: new Date(ms).toISOString()});
    } catch {
      toast.error(t.chats.schedulePastError);
    }
  };

  return {
    statusLabels,
    recurrenceLabels,
    isBusy: actionMutation.isPending || updateTimeMutation.isPending,
    editingId,
    editingTime,
    setEditingTime,
    confirmCancelId,
    minLocal: minScheduleDateTimeLocal(),
    startEditing,
    cancelEditing: () => {
      setEditingId(null);
      setEditingTime('');
    },
    saveTime,
    doAction: (id: string, action: 'pause' | 'resume' | 'cancel') =>
      actionMutation.mutate({id, action}),
    toggleCancelConfirm: (id: string) =>
      setConfirmCancelId((prev) => (prev === id ? null : id)),
  };
}
