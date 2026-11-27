import {http, results} from '@/lib/http';
import type {UnifiedStatusesResponse} from '@/api/contracts/misc';

export async function listMiscStatuses(deviceIds?: string[]): Promise<UnifiedStatusesResponse> {
  const res = await results<UnifiedStatusesResponse | null>(
    http.get('/misc/statuses', {
      params:
        deviceIds && deviceIds.length > 0 ? {deviceIds: deviceIds.join(',')} : undefined,
    }),
  );
  return (
    res ?? {
      data: [],
      accounts: [],
      device_errors: [],
    }
  );
}
