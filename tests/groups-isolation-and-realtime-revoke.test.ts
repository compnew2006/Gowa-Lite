import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import type {MessageInfo} from '../src/api/types.ts';

describe('Groups Isolation, Group Unread Tracking & Real-Time Message Revocation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-groups-revoke-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let dbMod: typeof import('../server/db.ts');
  let chatSyncMod: typeof import('../server/services/chat-sync.ts');
  let lifecycleMod: typeof import('../server/services/chat-lifecycle.ts');
  let unifiedMod: typeof import('../server/services/unified-chats-service.ts');
  let wsMod: typeof import('../server/ws-bridge.ts');
  let eventsMod: typeof import('../src/lib/events.ts');
  let notificationsMod: typeof import('../src/lib/notifications.ts');
  let reactionsMod: typeof import('../src/features/chat/message-reactions.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = dbPath;
    dbMod = await import('../server/db.ts');
    chatSyncMod = await import('../server/services/chat-sync.ts');
    lifecycleMod = await import('../server/services/chat-lifecycle.ts');
    unifiedMod = await import('../server/services/unified-chats-service.ts');
    wsMod = await import('../server/ws-bridge.ts');
    eventsMod = await import('../src/lib/events.ts');
    notificationsMod = await import('../src/lib/notifications.ts');
    reactionsMod = await import('../src/features/chat/message-reactions.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('excludes @g.us groups from unified chats, lifecycle assignments, tab counts, and DM notifications', () => {
    const roles = dbMod.listRoles();
    const managerRole = roles.find((r) => r.slug === 'manager')!;
    const manager = dbMod.createUser({
      username: 'grp_mgr',
      display_name: 'Group Manager',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: ['sales-1'],
      password: 'Password123',
    });

    const groupJid = '120363419978360489@g.us';
    const dmJid = '966501112233@s.whatsapp.net';

    assert.equal(chatSyncMod.isGroupJid(groupJid), true);
    assert.equal(chatSyncMod.isExcludedFromUnifiedChats(groupJid), true);
    assert.equal(chatSyncMod.isExcludedFromUnifiedChats(dmJid), false);
    assert.equal(lifecycleMod.isLifecycleApplicableJid(groupJid), false);
    assert.equal(lifecycleMod.isLifecycleApplicableJid(dmJid), true);

    assert.throws(
      () => lifecycleMod.normalizeLifecycleTarget('sales-1', groupJid),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as {code: string}).code === 'UNSUPPORTED_CHAT_TYPE',
    );

    // Seed legacy DB assignment rows for both a group and a DM
    const now = Date.now();
    dbMod.db
      .prepare(
        `INSERT INTO chat_assignments (
          device_id, chat_jid, status, assigned_user_id, closed_by_id, closed_at, cached_title, last_activity_ms, updated_at
        ) VALUES (?, ?, 'closed', NULL, ?, ?, ?, ?, ?)`,
      )
      .run('sales-1', groupJid, manager.id, new Date(now).toISOString(), 'Group 120363419978360489', now, now);
    dbMod.db
      .prepare(
        `INSERT INTO chat_assignments (
          device_id, chat_jid, status, assigned_user_id, closed_by_id, closed_at, cached_title, last_activity_ms, updated_at
        ) VALUES (?, ?, 'closed', NULL, ?, ?, ?, ?, ?)`,
      )
      .run('sales-1', dmJid, manager.id, new Date(now).toISOString(), 'DM Customer', now, now);

    const stats = lifecycleMod.getAssignmentStatsForDevices(['sales-1'], manager.id);
    assert.equal(stats.closed, 1);

    const dbClosed = lifecycleMod.listDbChatsByLifecycleStatus({
      deviceIds: ['sales-1'],
      status: 'closed',
    });
    assert.deepEqual(
      dbClosed.map((c) => c.jid),
      [dmJid],
    );

    const assignmentsMap = lifecycleMod.listAssignmentsForDevices(['sales-1']);
    const query = unifiedMod.parseUnifiedChatsQuery({tab: 'closed'}, manager);
    const dmChat: Parameters<typeof unifiedMod.computeUnifiedTabCounts>[0]['allChats'][number] = {
      jid: dmJid,
      name: 'DM Customer',
      last_message_time: new Date(now).toISOString(),
      ephemeral_expiration: 0,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      archived: false,
      device_id: 'sales-1',
      device_display_name: 'Sales 1',
      device_state: 'logged_in',
    };
    const counts = unifiedMod.computeUnifiedTabCounts({
      targetDeviceIds: ['sales-1'],
      allChats: [dmChat],
      assignmentsMap,
      remoteByKey: new Map([[`sales-1::${dmJid}`, dmChat]]),
      totalRemoteChats: 1,
      anyDeviceHasMore: false,
      skipRemoteScan: false,
      effectiveMeOwnerId: null,
      query,
    });
    assert.equal(counts.closed, 1);
    assert.equal(counts.all, 1);

    // Incoming customer lifecycle and DM notifications also ignore @g.us
    assert.equal(
      lifecycleMod.handleIncomingCustomerMessageLifecycle('sales-1', groupJid, now),
      null,
    );
    assert.equal(
      notificationsMod.extractIncomingAlertData({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'sales-1',
        result: {
          payload: {
            id: 'grp-msg-1',
            chat_jid: groupJid,
            from: '966501112233@s.whatsapp.net',
            body: 'Hello group',
            is_from_me: false,
          },
        },
      }),
      null,
    );
    assert.equal(
      notificationsMod.shouldAlertIncomingChat({
        user: manager,
        deviceId: 'sales-1',
        chatJid: groupJid,
      }),
      false,
    );
  });

  it('tracks @g.us group unread counts per user, clears them on markChatReadForUser, and gates @g.us WS events by groups:read', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const managerRole = roles.find((r) => r.slug === 'manager')!;

    const agent = dbMod.createUser({
      username: 'grp_unread_agent',
      display_name: 'No Groups Agent',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['sales-1'],
      password: 'Password123',
    });
    const manager = dbMod.createUser({
      username: 'grp_unread_mgr',
      display_name: 'Groups Manager',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: ['sales-1'],
      password: 'Password123',
    });

    const groupJid = '120363999000111222@g.us';
    chatSyncMod.handleUpstreamGowaEvent('sales-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        payload: {
          id: 'g-unread-1',
          chat_jid: groupJid,
          from: '966509998877@s.whatsapp.net',
          body: 'Group ping 1',
          is_from_me: false,
          timestamp: new Date().toISOString(),
        },
      },
    });
    chatSyncMod.handleUpstreamGowaEvent('sales-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        payload: {
          id: 'g-unread-2',
          chat_jid: groupJid,
          from: '966509998877@s.whatsapp.net',
          body: 'Group ping 2',
          is_from_me: false,
          timestamp: new Date().toISOString(),
        },
      },
    });
    // Outgoing message should not increment unread
    chatSyncMod.handleUpstreamGowaEvent('sales-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        payload: {
          id: 'g-unread-out',
          chat_jid: groupJid,
          from: 'me@s.whatsapp.net',
          body: 'My reply',
          is_from_me: true,
          timestamp: new Date().toISOString(),
        },
      },
    });

    const beforeRead = dbMod.getGroupUnreadSummaryForUser(manager, ['sales-1']);
    assert.equal(beforeRead.totalUnread, 2);
    assert.equal(beforeRead.byKey.get(`sales-1::${groupJid}`), 2);

    dbMod.markChatReadForUser(manager.id, 'sales-1', groupJid);
    const afterRead = dbMod.getGroupUnreadSummaryForUser(manager, ['sales-1']);
    assert.equal(afterRead.totalUnread, 0);

    // WS bridge authorization checks groups:read for @g.us events
    const groupWsPayload = {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      device_id: 'sales-1',
      result: {chat_jid: groupJid, id: 'g-ws-1', body: 'hi'},
    };
    assert.equal(wsMod.shouldDeliverWsEventToUser(agent, groupWsPayload).allowed, false);
    assert.equal(wsMod.shouldDeliverWsEventToUser(manager, groupWsPayload).allowed, true);
  });

  it('handles customer message deletion across JID/event variants in real time and patches message pages immediately', () => {
    const deviceId = 'sales-1';
    const chatJid = '966551234567@s.whatsapp.net';

    dbMod.upsertCachedMessages(deviceId, chatJid, [
      {
        id: 'cust-del-1',
        chat_jid: chatJid,
        sender_jid: chatJid,
        content: 'رسالة قبل الحذف',
        timestamp: '2026-11-24T10:00:00.000Z',
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
      {
        id: 'cust-del-2',
        chat_jid: chatJid,
        sender_jid: chatJid,
        content: 'رسالة ببروتوكول الحذف',
        timestamp: '2026-11-24T10:01:00.000Z',
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    ]);

    const broadcasted: Array<Record<string, unknown>> = [];

    // Case 1: Upstream MESSAGE_REVOKE with :device suffix & without chat_jid
    chatSyncMod.handleUpstreamGowaEvent(
      deviceId,
      {
        code: 'MESSAGE_REVOKE',
        message: 'revoked',
        result: {
          revoked_message_id: 'cust-del-1',
          from: '966551234567:12@s.whatsapp.net',
        },
      },
      (payload) => broadcasted.push(payload as Record<string, unknown>),
    );

    const row1 = dbMod.getCachedMessage(deviceId, chatJid, 'cust-del-1');
    assert.equal(row1?.is_revoked, true);
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].code, 'MESSAGE_REVOKED');
    assert.equal((broadcasted[0].result as {chat_jid?: string}).chat_jid, chatJid);

    const parsed1 = eventsMod.extractWsRevokeTarget({
      code: String(broadcasted[0].code),
      message: String(broadcasted[0].message),
      device_id: String(broadcasted[0].device_id),
      result: broadcasted[0].result,
    });
    assert.ok(parsed1);
    assert.equal(parsed1.deviceId, deviceId);
    assert.equal(parsed1.chatJid, chatJid);
    assert.equal(parsed1.messageId, 'cust-del-1');

    // Case 2: Upstream MESSAGE_RECEIVED carrying Baileys/GOWA protocolMessage REVOKE
    const protoEvent = {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      device_id: deviceId,
      result: {
        payload: {
          id: 'proto-wrapper-99',
          from: '966551234567:0@s.whatsapp.net',
          protocol_message: {
            type: 'REVOKE',
            key: {
              id: 'cust-del-2',
              remote_jid: '966551234567:0@s.whatsapp.net',
            },
          },
        },
      },
    };
    chatSyncMod.handleUpstreamGowaEvent(
      deviceId,
      {code: protoEvent.code, message: protoEvent.message, result: protoEvent.result},
      (payload) => broadcasted.push(payload as Record<string, unknown>),
    );

    const row2 = dbMod.getCachedMessage(deviceId, chatJid, 'cust-del-2');
    assert.equal(row2?.is_revoked, true);
    assert.equal(broadcasted.length, 2);

    const parsedProto = eventsMod.extractWsRevokeTarget(protoEvent);
    assert.ok(parsedProto);
    assert.equal(parsedProto.chatJid, chatJid);
    assert.equal(parsedProto.messageId, 'cust-del-2');

    // Frontend infinite query cache patching updates open chat immediately without refetch
    const msg1: MessageInfo = {
      id: 'cust-del-1',
      chat_jid: chatJid,
      sender_jid: chatJid,
      content: 'رسالة قبل الحذف',
      timestamp: '2026-11-24T10:00:00.000Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    };
    const msg2: MessageInfo = {
      id: 'cust-del-2',
      chat_jid: chatJid,
      sender_jid: chatJid,
      content: 'رسالة ببروتوكول الحذف',
      timestamp: '2026-11-24T10:01:00.000Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    };
    const cacheBefore = {
      pages: [{data: [msg2, msg1]}],
      pageParams: [0],
    };

    const unchanged = reactionsMod.applyRevokeToMessagePages(cacheBefore, {
      messageId: 'non-existent-id',
    });
    assert.equal(unchanged, cacheBefore);

    const updated1 = reactionsMod.applyRevokeToMessagePages(cacheBefore, parsed1);
    assert.ok(updated1);
    assert.equal(updated1.pages[0].data[1].is_revoked, true);
    assert.equal(updated1.pages[0].data[0].is_revoked, undefined);

    const updated2 = reactionsMod.applyRevokeToMessagePages(updated1, parsedProto);
    assert.ok(updated2);
    assert.equal(updated2.pages[0].data[0].is_revoked, true);
  });

  it('allows sending to @g.us groups under require_claim policy and normalizes wrapped newsletter arrays', async () => {
    const roles = dbMod.listRoles();
    const managerRole = roles.find((r) => r.slug === 'manager')!;
    const manager = dbMod.createUser({
      username: 'grp_sender_mgr',
      display_name: 'Group Sender',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: ['sales-1'],
      password: 'Password123',
    });

    lifecycleMod.updateInboxPolicy({
      unassigned_reply_policy: 'require_claim',
      closed_reply_policy: 'block',
    });

    const groupJid = '120363419978360489@g.us';
    const dmJid = '966509991122@s.whatsapp.net';

    // Groups are exempt from DM claim-before-reply lifecycle enforcement
    const groupPolicyResult = lifecycleMod.enforceInboxPolicyBeforeSend(
      manager,
      'sales-1',
      groupJid,
    );
    assert.equal(groupPolicyResult.lifecycleEvent, null);
    assert.equal(groupPolicyResult.assignment.chat_jid, groupJid);

    // DMs still enforce require_claim policy
    assert.throws(
      () => lifecycleMod.enforceInboxPolicyBeforeSend(manager, 'sales-1', dmJid),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as {code: string}).code === 'CLAIM_REQUIRED',
    );

    const miscMod = await import('../server/routes/misc.ts');
    assert.deepEqual(miscMod.extractArrayResult([{message_server_id: 1}]), [
      {message_server_id: 1},
    ]);
    assert.deepEqual(miscMod.extractArrayResult({data: [{message_server_id: 2}]}), [
      {message_server_id: 2},
    ]);
    assert.deepEqual(miscMod.extractArrayResult({messages: [{message_server_id: 3}]}), [
      {message_server_id: 3},
    ]);
    assert.deepEqual(miscMod.extractArrayResult({unexpected: true}), []);
    assert.deepEqual(miscMod.extractArrayResult(null), []);
  });
});
