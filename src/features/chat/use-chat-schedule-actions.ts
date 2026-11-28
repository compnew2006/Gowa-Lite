import {useMemo, useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {actionUnifiedChatSchedule, updateUnifiedChatSchedule} from '@/api/client';
import type {ScheduleStatus, ScheduledSend, UnifiedChat} from '@/api/types';
import {
  minScheduleDateTimeLocal,
  toLocalDateTimeInput,
  validateScheduleFutureMs,
} from '@/features/schedules/schedule-utils';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {buildScheduledDeepLink} from '@/features/schedules/scheduled-link';

/**
 * Shared edit-time / pause / resume / cancel logic for one chat's schedules.
 * Used by the schedules drawer and by the scheduled bubble in the chat
 * timeline — both hit the same PATCH + action routes, so a fix here fixes
 * both surfaces.
 */
export function useChatScheduleActions(chat: UnifiedChat) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const invalidateSchedules = () => {
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    });
    // Rows may belong to other devices (P1-1), so invalidate the whole
    // scheduled-page list prefix, not just this chat's device.
    void queryClient.invalidateQueries({queryKey: ['schedules']});
  };

  const actionMutation = useMutation({
    mutationFn: ({
      id,
      action,
      deviceId,
    }: {
      id: string;
      action: 'pause' | 'resume' | 'cancel';
      deviceId?: string;
    }) =>
      // P1-1: act on the row's owning device, not the chat's device.
      actionUnifiedChatSchedule(deviceId ?? chat.device_id, chat.jid, id, action),
    onSuccess: (_data, vars) => {
      if (vars.action === 'pause')
        toastWithView(t.scheduled.pausedToast, {
          label: t.scheduled.viewAction,
          to: buildScheduledDeepLink(chat.jid),
          navigate,
        });
      else if (vars.action === 'resume')
        toastWithView(t.scheduled.resumedToast, {
          label: t.scheduled.viewAction,
          to: buildScheduledDeepLink(chat.jid),
          navigate,
        });
      else {
        toastWithView(t.scheduled.cancelledToast, {
          label: t.scheduled.viewAction,
          to: buildScheduledDeepLink(chat.jid),
          navigate,
        });
        setConfirmCancelId(null);
      }
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateTimeMutation = useMutation({
    mutationFn: ({
      id,
      scheduledAt,
      deviceId,
    }: {
      id: string;
      scheduledAt: string;
      deviceId?: string;
    }) =>
      // P1-1: reschedule on the row's owning device, not the chat's device.
      updateUnifiedChatSchedule(deviceId ?? chat.device_id, chat.jid, id, {
        scheduled_at: scheduledAt,
      }),
    onSuccess: () => {
      toastWithView(t.chats.scheduleUpdatedToast, {
        label: t.scheduled.viewAction,
        to: buildScheduledDeepLink(chat.jid),
        navigate,
      });
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

  const saveTime = (id: string, deviceId?: string) => {
    try {
      const ms = validateScheduleFutureMs(editingTime);
      updateTimeMutation.mutate({id, scheduledAt: new Date(ms).toISOString(), deviceId});
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
    doAction: (id: string, action: 'pause' | 'resume' | 'cancel', deviceId?: string) =>
      actionMutation.mutate({id, action, deviceId}),
    toggleCancelConfirm: (id: string) =>
      setConfirmCancelId((prev) => (prev === id ? null : id)),
  };
}
