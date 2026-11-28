import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import type {GowaDevice} from '../server/gowa-client.ts';
import type {PublicUser} from '../server/db/auth-repo.ts';

// P0-1 — closed tab privacy: an agent must see ONLY the chats THEY closed
// (closed_by_id = their id); a supervisor sees all closed chats. List and
// counter must agree, in both the remote-scan and skipRemoteScan paths.
describe('Closed tab privacy (P0-1)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-closed-privacy-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let dbMod: typeof import('../server/db.ts');
  let lifecycleMod: typeof import('../server/services/chat-lifecycle.ts');
  let unifiedMod: typeof import('../server/services/unified-chats-service.ts');

  let agentA: PublicUser;
  let agentB: PublicUser;
  let supervisor: PublicUser;

  const deviceId = 'dev-1';
  const jidA = '966500000001@s.whatsapp.net'; // closed by agent A
  const jidB = '966500000002@s.whatsapp.net'; // closed by agent B
  const jidC = '966500000003@s.whatsapp.net'; // open, assigned to agent A
  const jidD = '966500000004@s.whatsapp.net'; // open, assigned to agent B
  const jidF = '966500000005@s.whatsapp.net'; // pending (no assignment row)

  type RemoteChat = Parameters<typeof unifiedMod.computeUnifiedTabCounts>[0]['allChats'][number];
  let remoteChats: RemoteChat[];
  let remoteByKey: Map<string, RemoteChat>;
  let deviceInfoMap: Map<string, {device: GowaDevice; displayName: string}>;

  function makeRemoteChat(jid: string, name: string): RemoteChat {
    const now = new Date().toISOString();
    return {
      jid,
      name,
      last_message_time: now,
      ephemeral_expiration: 0,
      created_at: now,
      updated_at: now,
      archived: false,
      device_id: deviceId,
      device_display_name: 'Dev 1',
      device_state: 'logged_in',
    };
  }

  function countsFor(user: PublicUser, skipRemoteScan: boolean) {
    const assignmentsMap = lifecycleMod.listAssignmentsForDevices([deviceId]);
    const query = unifiedMod.parseUnifiedChatsQuery({tab: 'closed'}, user);
    return unifiedMod.computeUnifiedTabCounts({
      targetDeviceIds: [deviceId],
      allChats: skipRemoteScan ? [] : remoteChats,
      assignmentsMap: skipRemoteScan ? new Map() : assignmentsMap,
      remoteByKey: skipRemoteScan ? new Map() : remoteByKey,
      totalRemoteChats: skipRemoteScan ? 0 : remoteChats.length,
      anyDeviceHasMore: false,
      skipRemoteScan,
      effectiveMeOwnerId: user.id,
      userId: user.id,
      query,
    });
  }

  function paginateClosed(user: PublicUser, opts: {offset?: number; search?: string} = {}) {
    const offset = opts.offset ?? 0;
    const counts = countsFor(user, offset > 0);
    const query = unifiedMod.parseUnifiedChatsQuery(
      {
        tab: 'closed',
        limit: '100',
        offset: String(offset),
        ...(opts.search ? {search: opts.search} : {}),
      },
      user,
    );
    return unifiedMod.paginateUnifiedChats({
      query,
      userId: user.id,
      targetDeviceIds: [deviceId],
      deviceInfoMap,
      allChats: remoteChats,
      remoteByKey,
      assignmentsMap: lifecycleMod.listAssignmentsForDevices([deviceId]),
      tabCounts: counts,
      totalRemoteChats: remoteChats.length,
      anyDeviceHasMore: false,
      effectiveMeOwnerId: user.id,
    });
  }

  function paginateTab(user: PublicUser, tab: string) {
    const counts = countsFor(user, false);
    const query = unifiedMod.parseUnifiedChatsQuery({tab, limit: '100'}, user);
    return {
      counts,
      result: unifiedMod.paginateUnifiedChats({
        query,
        userId: user.id,
        targetDeviceIds: [deviceId],
        deviceInfoMap,
        allChats: remoteChats,
        remoteByKey,
        assignmentsMap: lifecycleMod.listAssignmentsForDevices([deviceId]),
        tabCounts: counts,
        totalRemoteChats: remoteChats.length,
        anyDeviceHasMore: false,
        effectiveMeOwnerId: user.id,
      }),
    };
  }

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = dbPath;
    dbMod = await import('../server/db.ts');
    lifecycleMod = await import('../server/services/chat-lifecycle.ts');
    unifiedMod = await import('../server/services/unified-chats-service.ts');

    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const managerRole = roles.find((r) => r.slug === 'manager')!;
    agentA = dbMod.createUser({
      username: 'closed_agent_a',
      display_name: 'Agent A',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: [deviceId],
      password: 'Password123',
    });
    agentB = dbMod.createUser({
      username: 'closed_agent_b',
      display_name: 'Agent B',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: [deviceId],
      password: 'Password123',
    });
    supervisor = dbMod.createUser({
      username: 'closed_manager',
      display_name: 'Manager',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: [deviceId],
      password: 'Password123',
    });

    // Seed lifecycle state through the real flows so closed_by_id /
    // assigned_user_id are set exactly as production sets them.
    lifecycleMod.claimChat(agentA, deviceId, jidC, {cachedTitle: 'Charlie Customer'});
    lifecycleMod.claimChat(agentB, deviceId, jidD, {cachedTitle: 'Delta Customer'});
    lifecycleMod.closeChat(agentA, deviceId, jidA, {cachedTitle: 'Alpha Customer'});
    lifecycleMod.closeChat(agentB, deviceId, jidB, {cachedTitle: 'Beta Customer'});

    // Deterministic list ordering (B newer than A) regardless of ms ties.
    dbMod.db
      .prepare('UPDATE chat_assignments SET last_activity_ms = ? WHERE device_id = ? AND chat_jid = ?')
      .run(1000, deviceId, jidA);
    dbMod.db
      .prepare('UPDATE chat_assignments SET last_activity_ms = ? WHERE device_id = ? AND chat_jid = ?')
      .run(2000, deviceId, jidB);
    dbMod.db
      .prepare('UPDATE chat_assignments SET last_activity_ms = ? WHERE device_id = ? AND chat_jid = ?')
      .run(3000, deviceId, jidC);
    dbMod.db
      .prepare('UPDATE chat_assignments SET last_activity_ms = ? WHERE device_id = ? AND chat_jid = ?')
      .run(4000, deviceId, jidD);

    remoteChats = [
      makeRemoteChat(jidA, 'Alpha Customer'),
      makeRemoteChat(jidB, 'Beta Customer'),
      makeRemoteChat(jidC, 'Charlie Customer'),
      makeRemoteChat(jidD, 'Delta Customer'),
      makeRemoteChat(jidF, 'Foxtrot Customer'),
    ];
    remoteByKey = new Map(remoteChats.map((c) => [`${deviceId}::${c.jid}`, c]));
    deviceInfoMap = new Map([
      [
        deviceId,
        {
          device: {id: deviceId, state: 'logged_in', created_at: new Date().toISOString()},
          displayName: 'Dev 1',
        },
      ],
    ]);
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('repo: closed list filtered by closer, unfiltered for supervisors', () => {
    const mineA = lifecycleMod.listDbChatsByLifecycleStatus({
      deviceIds: [deviceId],
      status: 'closed',
      ownerUserId: agentA.id,
    });
    assert.deepEqual(
      mineA.map((c) => c.jid),
      [jidA],
    );

    const mineB = lifecycleMod.listDbChatsByLifecycleStatus({
      deviceIds: [deviceId],
      status: 'closed',
      ownerUserId: agentB.id,
    });
    assert.deepEqual(
      mineB.map((c) => c.jid),
      [jidB],
    );

    const all = lifecycleMod.listDbChatsByLifecycleStatus({
      deviceIds: [deviceId],
      status: 'closed',
    });
    assert.deepEqual(
      all.map((c) => c.jid).sort(),
      [jidA, jidB].sort(),
    );
  });

  it('repo: closed counter filtered by closer, unfiltered for supervisors', () => {
    assert.equal(lifecycleMod.getAssignmentStatsForDevices([deviceId], agentA.id, agentA.id).closed, 1);
    assert.equal(lifecycleMod.getAssignmentStatsForDevices([deviceId], agentB.id, agentB.id).closed, 1);
    assert.equal(lifecycleMod.getAssignmentStatsForDevices([deviceId], supervisor.id).closed, 2);
    assert.equal(lifecycleMod.getAssignmentStatsForDevices([deviceId], supervisor.id, null).closed, 2);
  });

  it('agent sees only their own closed chats in list AND counter (remote-scan path)', () => {
    const counts = countsFor(agentA, false);
    assert.equal(counts.closed, 1);

    const {pagedChats, totalAvailable, hasMore} = paginateClosed(agentA);
    assert.deepEqual(
      pagedChats.map((c) => c.jid),
      [jidA],
    );
    assert.equal(totalAvailable, 1);
    assert.equal(hasMore, false);
  });

  it('agent sees only their own closed chats in list AND counter (skipRemoteScan path)', () => {
    const counts = countsFor(agentA, true);
    assert.equal(counts.closed, 1);

    const {pagedChats, totalAvailable, hasMore} = paginateClosed(agentA, {offset: 1});
    assert.deepEqual(pagedChats, []);
    assert.equal(totalAvailable, 1);
    assert.equal(hasMore, false);
  });

  it('supervisor sees all closed chats in list AND counter, both paths', () => {
    assert.equal(countsFor(supervisor, false).closed, 2);
    assert.equal(countsFor(supervisor, true).closed, 2);

    const first = paginateClosed(supervisor);
    assert.deepEqual(
      first.pagedChats.map((c) => c.jid),
      [jidB, jidA],
    );
    assert.equal(first.totalAvailable, 2);
    assert.equal(first.hasMore, false);

    const second = paginateClosed(supervisor, {offset: 1});
    assert.deepEqual(
      second.pagedChats.map((c) => c.jid),
      [jidA],
    );
    assert.equal(second.totalAvailable, 2);
    assert.equal(second.hasMore, false);
  });

  it('search mode does not leak another agent closed chat', () => {
    const other = paginateClosed(agentA, {search: 'Beta'});
    assert.deepEqual(other.pagedChats, []);
    assert.equal(other.totalAvailable, 0);

    const own = paginateClosed(agentA, {search: 'Alpha'});
    assert.deepEqual(
      own.pagedChats.map((c) => c.jid),
      [jidA],
    );

    const sup = paginateClosed(supervisor, {search: 'Beta'});
    assert.deepEqual(
      sup.pagedChats.map((c) => c.jid),
      [jidB],
    );
  });

  it('me/open/pending tabs are unchanged for the agent', () => {
    const counts = countsFor(agentA, false);
    assert.equal(counts.me, 1);
    assert.equal(counts.open, 1);
    assert.equal(counts.pending, 1);

    const me = paginateTab(agentA, 'me');
    assert.deepEqual(
      me.result.pagedChats.map((c) => c.jid),
      [jidC],
    );
    assert.equal(me.result.totalAvailable, 1);

    const open = paginateTab(agentA, 'open');
    assert.deepEqual(
      open.result.pagedChats.map((c) => c.jid),
      [jidC],
    );
    assert.equal(open.result.totalAvailable, 1);

    const pending = paginateTab(agentA, 'pending');
    assert.deepEqual(
      pending.result.pagedChats.map((c) => c.jid),
      [jidF],
    );
    assert.equal(pending.result.totalAvailable, 1);
  });

  it('supervisor open tab still sees every open chat', () => {
    const open = paginateTab(supervisor, 'open');
    assert.deepEqual(
      open.result.pagedChats.map((c) => c.jid).sort(),
      [jidC, jidD].sort(),
    );
    assert.equal(open.result.totalAvailable, 2);
  });

  it('customer-message auto-reopen still works and drops the chat from the closed tab', () => {
    const payload = lifecycleMod.handleIncomingCustomerMessageLifecycle(deviceId, jidA, Date.now());
    assert.notEqual(payload, null);
    assert.equal(payload?.result.assignment.status, 'pending');

    assert.equal(countsFor(agentA, false).closed, 0);
    assert.equal(countsFor(agentA, true).closed, 0);
    const {pagedChats, totalAvailable} = paginateClosed(agentA);
    assert.deepEqual(pagedChats, []);
    assert.equal(totalAvailable, 0);

    // The other agent's closed chat is untouched.
    assert.equal(countsFor(agentB, false).closed, 1);
    assert.equal(countsFor(supervisor, false).closed, 1);
  });
});
