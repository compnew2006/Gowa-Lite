import 'dotenv/config';
import {WebSocket} from 'ws';
import {getGowaConfig} from '../server/db.ts';
import {
  gowaFetch,
  validateGowaUrl,
  type GowaAppInfo,
  type GowaDevice,
} from '../server/gowa-client.ts';
import {buildUpstreamWsTarget} from '../server/ws-bridge.ts';

async function main(): Promise<void> {
  const saved = getGowaConfig();
  const targetUrl = (process.env.GOWA_URL?.trim() || saved.url || '').replace(/\/+$/, '');
  const username = process.env.GOWA_USERNAME?.trim() ?? saved.username ?? '';
  const password = process.env.GOWA_PASSWORD ?? saved.password ?? '';

  if (!targetUrl) {
    console.error('[verify:live] خطأ: لم يتم ضبط GOWA_URL في البيئة ولا في قاعدة البيانات.');
    console.error('مثال: GOWA_URL=https://gowa.example.com GOWA_USERNAME=... GOWA_PASSWORD=... npm run verify:live');
    process.exit(1);
  }

  const safeUrl = validateGowaUrl(targetUrl);
  const configOverride = {url: safeUrl, username, password};
  console.log(`[verify:live] فحص الخادم: ${safeUrl}`);

  const appInfo = await gowaFetch<GowaAppInfo>('/app/info', {
    configOverride,
    timeoutMs: 8_000,
  }).catch((err) => {
    console.warn(`[verify:live] تحذير: فشل قراءة /app/info (${err instanceof Error ? err.message : String(err)})`);
    return null;
  });

  if (appInfo) {
    console.log(
      `[verify:live] /app/info: OK (version=${appInfo.version || 'unknown'}, scheduled_sends=${String(appInfo.scheduled_sends ?? 'unknown')})`,
    );
  }

  const devices = await gowaFetch<GowaDevice[]>('/devices', {
    configOverride,
    timeoutMs: 8_000,
  });
  console.log(`[verify:live] /devices: OK (count=${devices.length})`);

  const connectedDevice = devices.find(
    (d) => d.state === 'logged_in' || d.state === 'connected',
  );

  if (connectedDevice) {
    const schedules = await gowaFetch<{data?: unknown[]; pagination?: {total?: number}}>(
      '/send/schedules',
      {
        configOverride,
        deviceId: connectedDevice.id,
        query: {limit: 5, offset: 0},
        timeoutMs: 8_000,
      },
    ).catch((err) => {
      console.warn(
        `[verify:live] تحذير /send/schedules للحساب ${connectedDevice.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (schedules) {
      console.log(
        `[verify:live] /send/schedules (${connectedDevice.id}): OK (total=${schedules.pagination?.total ?? schedules.data?.length ?? 0})`,
      );
    }
  } else {
    console.warn('[verify:live] لا يوجد جهاز متصل حاليًا؛ تم تخطي فحص /send/schedules.');
  }

  const wsTarget = buildUpstreamWsTarget(
    {url: safeUrl, username, password},
    connectedDevice?.id ?? '',
    {allowQueryAuth: process.env.GOWA_WS_QUERY_AUTH === 'true'},
  );
  if (!wsTarget) {
    throw new Error('تعذر بناء رابط WebSocket للخادم');
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsTarget.url, {headers: wsTarget.headers});
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('انتهت مهلة التحقق من اتصال WebSocket (8s)'));
    }, 8_000);

    ws.once('open', () => {
      clearTimeout(timer);
      console.log(`[verify:live] WebSocket (${connectedDevice?.id || 'default'}): OK`);
      ws.close();
      resolve();
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  console.log('[verify:live] اكتمل الفحص الحي بنجاح — يمكنك الآن إغلاق بند PROD-03 إذا تأكدت من أحداث الرسائل الحية.');
}

main().catch((err) => {
  console.error('[verify:live] فشل الفحص:', err instanceof Error ? err.message : err);
  process.exit(1);
});
