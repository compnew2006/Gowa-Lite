import {toast} from 'sonner';

/**
 * P1-15 (decision 20): a success toast with a «view» action that navigates
 * to a page — a deep link where the item has an id (or another filter key),
 * a plain page link where it does not. Generalising this to other toasts is
 * P2-10 (Phase 5); for now the schedule-created toast is the only caller.
 */
export function toastWithView(
  message: string,
  options: {
    label: string;
    to: string;
    navigate: (to: string) => void;
  },
): void {
  toast.success(message, {
    action: {
      label: options.label,
      onClick: () => options.navigate(options.to),
    },
  });
}
