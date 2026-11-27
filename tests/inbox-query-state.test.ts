import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/react-query';
import {describe, it} from 'node:test';
import type {UnifiedChat, UnifiedChatsResponse} from '../src/api/types.ts';
import {
  createUnifiedChatsQueryOptions,
  markPrivateChatReadInInboxCache,
} from '../src/features/chat/inbox-queries.ts';
import {
  UNIFIED_CHATS_QUERY_PREFIX,
  unifiedChatsQueryKey,
} from '../src/features/chat/inbox-query-keys.ts';

function makeChat(deviceId: string, jid: string, unreadCount: number): UnifiedChat {
  return {
    device_id: deviceId,
    jid,
    name: jid,
    device_display_name: deviceId,
    device_state: 'connected',
    last_message_time: '',
    ephemeral_expiration: 0,
    created_at: '',
    updated_at: '',
    archived: false,
    unread_count: unreadCount,
  };
}

function makeResponse(data: UnifiedChat[], totalUnread: number): UnifiedChatsResponse {
  return {
    data,
    total: data.length,
    total_unread: totalUnread,
    accounts: [],
    device_errors: [],
  };
}

describe('inbox query state', () => {
  it('keeps the default and filtered key shapes stable', () => {
    assert.deepEqual(UNIFIED_CHATS_QUERY_PREFIX, ['unified-chats']);
    assert.deepEqual(
      unifiedChatsQueryKey({
        deviceIds: [],
        search: '',
        hasMedia: false,
        tab: 'all',
        assignedTo: '',
      }),
      ['unified-chats', [], '', false],
    );
    assert.deepEqual(
      unifiedChatsQueryKey({
        deviceIds: ['device-1'],
        search: 'Alice',
        hasMedia: true,
        tab: 'open',
        assignedTo: 'me',
      }),
      ['unified-chats', ['device-1'], 'alice', true, 'open', 'me'],
    );
  });

  it('shares default query options while retaining caller overrides and filtered request settings', () => {
    const defaultOptions = createUnifiedChatsQueryOptions();
    assert.deepEqual(defaultOptions.queryKey, ['unified-chats', [], '', false]);
    assert.equal(defaultOptions.staleTime, 25_000);

    const overriddenOptions = createUnifiedChatsQueryOptions({
      options: {staleTime: 20_000, enabled: false},
    });
    assert.equal(overriddenOptions.staleTime, 20_000);
    assert.equal(overriddenOptions.enabled, false);

    const filteredOptions = createUnifiedChatsQueryOptions({
      filters: {
        deviceIds: ['device-1'],
        search: '  Alice  ',
        hasMedia: true,
        tab: 'open',
        assignedTo: 'me',
      },
    });
    assert.deepEqual(filteredOptions.queryKey, [
      'unified-chats', ['device-1'], 'Alice', true, 'open', 'me',
    ]);
    assert.equal(Object.hasOwn(filteredOptions, 'staleTime'), true);
    assert.equal(filteredOptions.staleTime, undefined);
  });

  it('clears only the matching device and JID once in every inbox cache, leaving groups untouched', () => {
    const client = new QueryClient();
    const defaultKey = ['unified-chats', [], '', false] as const;
    const filteredKey = ['unified-chats', ['device-1'], 'alice', false, 'open', ''] as const;
    const targetJid = 'alice@s.whatsapp.net';
    const defaultBefore = makeResponse([
      makeChat('device-1', targetJid, 3),
      makeChat('device-2', targetJid, 5),
      makeChat('device-1', 'bob@s.whatsapp.net', 4),
    ], 12);
    const filteredBefore = makeResponse([makeChat('device-1', targetJid, 3)], 3);
    const groupBefore = {items: [{device_id: 'device-1', jid: targetJid, unread_count: 3}]};

    client.setQueryData(defaultKey, defaultBefore);
    client.setQueryData(filteredKey, filteredBefore);
    client.setQueryData(['unified-groups'], groupBefore);

    markPrivateChatReadInInboxCache(client, 'device-1', targetJid);

    const defaultAfter = client.getQueryData<UnifiedChatsResponse>(defaultKey);
    const filteredAfter = client.getQueryData<UnifiedChatsResponse>(filteredKey);
    assert.deepEqual(defaultAfter?.data.map((chat) => chat.unread_count), [0, 5, 4]);
    assert.equal(defaultAfter?.total_unread, 9);
    assert.equal(filteredAfter?.data[0]?.unread_count, 0);
    assert.equal(filteredAfter?.total_unread, 0);
    assert.deepEqual(client.getQueryData(['unified-groups']), groupBefore);

    markPrivateChatReadInInboxCache(client, 'device-1', targetJid);
    assert.equal(client.getQueryData<UnifiedChatsResponse>(defaultKey)?.total_unread, 9);
    assert.equal(client.getQueryData<UnifiedChatsResponse>(filteredKey)?.total_unread, 0);
  });

  it('does not decrement a stale total below zero and falls back to the patched rows when absent', () => {
    const client = new QueryClient();
    const key = ['unified-chats', [], '', false] as const;
    const target = makeChat('device-1', 'alice@s.whatsapp.net', 3);
    const withoutTotal = makeResponse([target], 3);
    delete withoutTotal.total_unread;
    client.setQueryData(key, {...withoutTotal, total_unread: -1});

    markPrivateChatReadInInboxCache(client, 'device-1', target.jid);

    const after = client.getQueryData<UnifiedChatsResponse>(key);
    assert.equal(after?.total_unread, 0);
    assert.equal(after?.data[0]?.unread_count, 0);

    client.setQueryData(key, withoutTotal);
    markPrivateChatReadInInboxCache(client, 'device-1', target.jid);
    assert.equal(client.getQueryData<UnifiedChatsResponse>(key)?.total_unread, 0);
  });
});
