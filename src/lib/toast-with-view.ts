import {toast} from 'sonner';

/**
 * P1-15 (decision 20): a toast with a «view» action that navigates to a
 * page — a deep link where the item has an id (or another filter key), a
 * plain page link where it does not. P2-10 generalises this helper to
 * every toast that has a viewable item (claim/close, notes, accounts,
 * groups, schedules, bulk results, …).
 */
export function toastWithView(
  message: string,
  options: {
    label: string;
    to: string;
    navigate: (to: string) => void;
    // Most generalised toasts are successes; partial/failed outcomes keep
    // their warning tone while still offering the view link.
    kind?: 'success' | 'warning' | 'info';
  },
): void {
  const show =
    options.kind === 'warning'
      ? toast.warning
      : options.kind === 'info'
        ? toast.info
        : toast.success;
  show(message, {
    action: {
      label: options.label,
      onClick: () => options.navigate(options.to),
    },
  });
}
