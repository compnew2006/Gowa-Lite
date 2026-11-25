import {QueryClient} from '@tanstack/react-query';

export function invalidateChatQueries(
  client: QueryClient, rootKey: string, target: {deviceId?: string; chatJid?: string},
): void {
  const queryKey = [rootKey];
  if (target.deviceId) {
    queryKey.push(target.deviceId);
    if (target.chatJid) queryKey.push(target.chatJid);
  }
  void client.invalidateQueries({queryKey});
}

const NON_RETRYABLE_CODES = new Set([
  'GOWA_UNREACHABLE',
  'GOWA_NOT_CONFIGURED',
  'GOWA_UNAUTHORIZED',
  'NOT_GOWA_SERVER',
  'INVALID_RESPONSE',
  'PROXY_COOKIE_CHECK',
  'FORBIDDEN',
  'DEVICE_FORBIDDEN',
]);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failureCount, error) => {
        if (failureCount >= 1) return false;
        if (typeof error === 'object' && error !== null) {
          const maybe = error as {status?: unknown; code?: unknown};
          if (typeof maybe.status === 'number' && maybe.status >= 400 && maybe.status < 500) {
            return false;
          }
          if (typeof maybe.code === 'string' && NON_RETRYABLE_CODES.has(maybe.code)) {
            return false;
          }
        }
        return true;
      },
      refetchOnWindowFocus: false,
    },
  },
});
