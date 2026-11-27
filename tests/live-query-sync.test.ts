import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QueryClient} from '@tanstack/react-query';
import {syncLiveQueryCache} from '../src/lib/live-query-sync.ts';

const inbox = (devices: string[]) => ['unified-chats', devices] as const;
const messages = (device: string, jid: string) => ['unified-messages', device, jid] as const;
const jid = '201000000001@s.whatsapp.net';
const group = '1234@g.us';

test('message events invalidate only the matching account and conversation caches', () => {
  const client = new QueryClient();
  const affected = [inbox([]), inbox(['one']), messages('one', jid)];
  const unaffected = [inbox(['two']), messages('two', jid), messages('one', group), ['unified-groups']];
  for (const key of [...affected, ...unaffected]) client.setQueryData(key, {stored: true});

  syncLiveQueryCache(client, {code: 'MESSAGE_EDITED', message: '', device_id: 'one', result: {chat_jid: jid}});

  for (const key of affected) assert.equal(client.getQueryState(key)?.isInvalidated, true);
  for (const key of unaffected) assert.equal(client.getQueryState(key)?.isInvalidated, false);
});

test('reaction events patch only the target message and preserve the inbox cache', () => {
  const client = new QueryClient();
  const message = {id: 'target', reactions: []};
  const fixture = {pageParams: [0], pages: [{data: [message, {id: 'other', reactions: []}]}]};
  client.setQueryData(messages('one', jid), fixture);
  client.setQueryData(messages('two', jid), fixture);
  client.setQueryData(inbox([]), {stored: true});

  const event = {
    code: 'MESSAGE_REACTION',
    message: '',
    device_id: 'one',
    result: {
      chat_jid: jid,
      message_id: 'target',
      emoji: '👍',
      sender_jid: jid,
      is_from_me: false,
      timestamp: '2026-11-27T00:00:00Z',
    },
  };
  syncLiveQueryCache(client, event);
  const updated = client.getQueryData<typeof fixture>(messages('one', jid));
  assert.equal(updated?.pages[0].data[0].reactions.length, 1);
  assert.deepEqual(updated?.pages[0].data[1], fixture.pages[0].data[1]);
  assert.equal(client.getQueryData(messages('two', jid)), fixture);
  assert.equal(client.getQueryState(inbox([]))?.isInvalidated, false);

  syncLiveQueryCache(client, {...event, result: {...event.result, emoji: ''}});
  assert.deepEqual(client.getQueryData(messages('one', jid)), fixture);
});
