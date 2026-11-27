import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QueryClient} from '@tanstack/react-query';
import {chatLifecycleQueryKeys, messageQueryKeys} from '../src/features/chat/message-query-keys.ts';
import {messageHistoryOptions} from '../src/features/chat/message-history-query.ts';
import {syncLiveQueryCache} from '../src/lib/live-query-sync.ts';

const inbox = (devices: string[]) => ['unified-chats', devices] as const;
const messages = (device: string, jid: string) => ['unified-messages', device, jid] as const;
const jid = '201000000001@s.whatsapp.net';
const group = '1234@g.us';

test('chat query key helpers preserve existing message and lifecycle key shapes', () => {
  assert.deepEqual(messageHistoryOptions('one', jid).queryKey, [
    'unified-messages', 'one', jid, '', false,
  ]);
  assert.deepEqual(messageQueryKeys.history('one', jid, 'invoice', true), [
    'unified-messages', 'one', jid, 'invoice', true,
  ]);
  assert.deepEqual(chatLifecycleQueryKeys.chat('one', jid), ['chat-lifecycle', 'one', jid]);
});

test('message events invalidate only the matching account and conversation caches', () => {
  const client = new QueryClient();
  const affected = [
    inbox([]),
    inbox(['one']),
    messages('one', jid),
    messageQueryKeys.history('one', jid, 'invoice'),
    messageQueryKeys.history('one', jid, '', true),
  ];
  const unaffected = [
    inbox(['two']),
    messages('two', jid),
    messages('one', group),
    ['unified-groups'],
  ];
  for (const key of [...affected, ...unaffected]) client.setQueryData(key, {stored: true});

  syncLiveQueryCache(client, {code: 'MESSAGE_EDITED', message: '', device_id: 'one', result: {chat_jid: jid}});

  for (const key of affected) assert.equal(client.getQueryState(key)?.isInvalidated, true);
  for (const key of unaffected) assert.equal(client.getQueryState(key)?.isInvalidated, false);
});

test('lifecycle events invalidate only the matching account and conversation lifecycle key', () => {
  const client = new QueryClient();
  const affected = chatLifecycleQueryKeys.chat('one', jid);
  const otherAccount = chatLifecycleQueryKeys.chat('two', jid);
  const otherChat = chatLifecycleQueryKeys.chat('one', group);
  for (const key of [affected, otherAccount, otherChat]) client.setQueryData(key, {stored: true});

  syncLiveQueryCache(client, {
    code: 'CHAT_LIFECYCLE_UPDATED',
    message: '',
    device_id: 'one',
    result: {chat_jid: jid},
  });

  assert.equal(client.getQueryState(affected)?.isInvalidated, true);
  assert.equal(client.getQueryState(otherAccount)?.isInvalidated, false);
  assert.equal(client.getQueryState(otherChat)?.isInvalidated, false);
});

test('reaction events patch only the target message and preserve the inbox cache', () => {
  const client = new QueryClient();
  const message = {id: 'target', reactions: []};
  const fixture = {pageParams: [0], pages: [{data: [message, {id: 'other', reactions: []}]}]};
  const targetVariants = [
    messages('one', jid),
    messageQueryKeys.history('one', jid, 'invoice'),
    messageQueryKeys.history('one', jid, '', true),
  ];
  for (const key of targetVariants) client.setQueryData(key, fixture);
  client.setQueryData(messages('two', jid), fixture);
  const noTarget = {pageParams: [0], pages: [{data: [{id: 'other', reactions: []}]}]};
  const noTargetKey = messageQueryKeys.history('one', jid, 'missing');
  client.setQueryData(noTargetKey, noTarget);
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
  for (const key of targetVariants) {
    const updated = client.getQueryData<typeof fixture>(key);
    assert.equal(updated?.pages[0].data[0].reactions.length, 1);
    assert.deepEqual(updated?.pages[0].data[1], fixture.pages[0].data[1]);
  }
  assert.equal(client.getQueryData(messages('two', jid)), fixture);
  assert.equal(client.getQueryData(noTargetKey), noTarget);
  assert.equal(client.getQueryState(inbox([]))?.isInvalidated, false);

  syncLiveQueryCache(client, {...event, result: {...event.result, emoji: ''}});
  for (const key of targetVariants) {
    assert.deepEqual(client.getQueryData(key), fixture);
  }
});
