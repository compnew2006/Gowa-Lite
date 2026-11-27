import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, test} from 'node:test';
import type {PublicUser} from '../server/db.ts';
import type {GowaChatInfo, GowaDevice} from '../server/gowa-client.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'gowa-unified-search-'));
process.env.GOWA_LITE_DB_PATH = join(tempDir, 'test.db');
delete process.env.GOWA_SETTINGS_SECRET;

let db: typeof import('../server/db.ts');
let service: typeof import('../server/services/unified-chats-service.ts');
let user: PublicUser;

const devices: GowaDevice[] = ['one', 'two'].map((id) => ({
  id,
  state: 'logged_in',
  created_at: '',
}));
const phoneJid = '201012345678@s.whatsapp.net';
const fallbackJid = '201098765432@s.whatsapp.net';
const contactJid = '201099999999@s.whatsapp.net';
const groupJid = '201012345678@g.us';

function chat(jid: string, name = 'Customer'): GowaChatInfo {
  return {
    jid,
    name,
    last_message_time: '2026-01-01T00:00:00Z',
    ephemeral_expiration: 0,
    created_at: '',
    updated_at: '',
    archived: false,
  };
}

type GatewayRequest = {
  deviceId: string;
  path: string;
  search: string | null;
  offset: number;
  hasMedia: boolean;
};

const requests: GatewayRequest[] = [];
const gateway = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  const deviceId = String(req.headers['x-device-id']);
  const search = url.searchParams.get('search');
  const offset = Number(url.searchParams.get('offset'));
  requests.push({
    deviceId,
    path: url.pathname,
    search,
    offset,
    hasMedia: url.searchParams.get('has_media') === 'true',
  });
  const reply = (results: unknown) => res.end(JSON.stringify({code: 'SUCCESS', results}));

  if (url.pathname === '/user/my/contacts') {
    return reply({data: [{jid: contactJid, name: 'VIP contact'}, {jid: phoneJid, name: 'Saved contact'}]});
  }
  if (search !== null) {
    if (search === '98765432' && deviceId === 'two') {
      res.statusCode = 503;
      return res.end(JSON.stringify({code: 'UNAVAILABLE'}));
    }
    let hits: GowaChatInfo[] = [];
    if (search === '1012345678') {
      hits = [chat(phoneJid, deviceId === 'two' ? '' : 'Customer'), chat(groupJid)];
    } else if (search === '98765') {
      hits = deviceId === 'one' ? [chat(fallbackJid)] : [chat('98765@g.us')];
    } else if (search === 'VIP') {
      hits = [chat('vip-direct@s.whatsapp.net', 'VIP Direct')];
    }
    return reply({data: hits, pagination: {limit: 50, offset: 0, total: hits.length}});
  }

  const data = Array.from({length: 100}, (_, i) => chat(`555${offset + i}@s.whatsapp.net`));
  if (offset === 900) data.splice(0, 2, chat(fallbackJid), chat(contactJid, ''));
  return reply({data, pagination: {limit: 100, offset, total: 11_238}});
});

before(async () => {
  db = await import('../server/db.ts');
  service = await import('../server/services/unified-chats-service.ts');
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  db.setGowaConfig({url: `http://127.0.0.1:${address.port}`, username: '', password: ''});
  user = db.createUser({
    username: 'search-admin',
    display_name: 'Search Admin',
    password: 'SearchAdmin123',
    role: 'admin',
  });
});

beforeEach(() => { requests.length = 0; });

after(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  db?.closeDatabaseSafely();
  rmSync(tempDir, {recursive: true, force: true});
});

function searchChats(search: string, options: Record<string, string> = {}) {
  return service.fetchRemoteChatsForDevices({
    targetDevices: devices,
    aliases: {},
    query: service.parseUnifiedChatsQuery({search, ...options}, user),
  });
}

test('numeric gateway hits skip unfiltered pages per device and look up missing names only', async () => {
  const result = await searchChats('٠١٠-١٢٣٤-٥٦٧٨', {has_media: 'true'});
  assert.deepEqual(
    result.allChats.map(({device_id, jid, name}) => [device_id, jid, name]).sort(),
    [['one', phoneJid, 'Customer'], ['two', phoneJid, 'Saved contact']],
  );
  assert.equal(result.totalRemoteChats, 2);
  assert.deepEqual(result.deviceErrors, []);
  const chatRequests = requests.filter(({path}) => path === '/chats');
  assert.deepEqual(chatRequests.map(({deviceId, search, offset, hasMedia}) =>
    [deviceId, search, offset, hasMedia]).sort(), [
    ['one', '1012345678', 0, true],
    ['two', '1012345678', 0, true],
  ]);
  assert.deepEqual(requests.filter(({path}) => path === '/user/my/contacts').map(({deviceId}) => deviceId), ['two']);
});

test('numeric search falls back on empty and failed direct responses', async () => {
  const result = await searchChats('98765432');
  assert.deepEqual(result.allChats.map(({device_id, jid}) => [device_id, jid]).sort(), [
    ['one', fallbackJid],
    ['two', fallbackJid],
  ]);
  assert.deepEqual(result.deviceErrors, []);
  assert.equal(requests.filter(({path, search}) => path === '/chats' && search === null).length, 20);
});

test('only the account without a visible numeric hit scans older pages', async () => {
  const result = await searchChats('98765');
  assert.deepEqual(result.allChats.map(({device_id, jid}) => [device_id, jid]).sort(), [
    ['one', fallbackJid],
    ['two', fallbackJid],
  ]);
  const scanRequests = requests.filter(({path, search}) => path === '/chats' && search === null);
  assert.equal(scanRequests.length, 10);
  assert.ok(scanRequests.every(({deviceId}) => deviceId === 'two'));
});

test('name search merges gateway hits with saved names from older chat pages', async () => {
  const result = await searchChats('VIP');
  assert.deepEqual(result.allChats.map(({jid, name}) => [jid, name]).sort(), [
    [contactJid, 'VIP contact'],
    [contactJid, 'VIP contact'],
    ['vip-direct@s.whatsapp.net', 'VIP Direct'],
    ['vip-direct@s.whatsapp.net', 'VIP Direct'],
  ]);
  assert.equal(requests.filter(({path, offset}) => path === '/chats' && offset === 900).length, 2);
});
