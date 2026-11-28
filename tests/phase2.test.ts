import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase2-'));
process.env.GOWA_LITE_DB_PATH = path.join(tempDir, 'test.db');

type DbModule = typeof import('../server/db.ts');
type GowaModule = typeof import('../server/gowa-client.ts');
type WsBridgeModule = typeof import('../server/ws-bridge.ts');
type ScheduleServiceModule = typeof import('../server/services/schedule-service.ts');
type ScheduleUtilsModule = typeof import('../src/features/schedules/schedule-utils.ts');
type ParticipantsModule = typeof import('../src/lib/participants.ts');

let dbMod: DbModule;
let gowaMod: GowaModule;
let wsMod: WsBridgeModule;
let schedSvc: ScheduleServiceModule;
let schedUtils: ScheduleUtilsModule;
let participantsMod: ParticipantsModule;

before(async () => {
  dbMod = await import('../server/db.ts');
  gowaMod = await import('../server/gowa-client.ts');
  wsMod = await import('../server/ws-bridge.ts');
  schedSvc = await import('../server/services/schedule-service.ts');
  schedUtils = await import('../src/features/schedules/schedule-utils.ts');
  participantsMod = await import('../src/lib/participants.ts');
});

after(() => {
  try {
    dbMod?.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('Phase 2 WebSocket Auth & Schedule/Participant DRY Helpers', () => {
  it('sends GOWA WS credentials in Authorization header by default without query string leakage (WS-01)', () => {
    const target = wsMod.buildUpstreamWsTarget(
      {url: 'https://gowa.example.com/api', username: 'alice', password: 'secret'},
      'dev-1',
    );
    assert.ok(target);
    const parsed = new URL(target.url);
    assert.equal(parsed.protocol, 'wss:');
    assert.equal(parsed.pathname, '/api/ws');
    assert.equal(parsed.searchParams.get('device_id'), 'dev-1');
    assert.equal(parsed.searchParams.get('authorization'), null);
    assert.equal(
      target.headers?.Authorization,
      `Basic ${Buffer.from('alice:secret', 'utf8').toString('base64')}`,
    );

    const compatTarget = wsMod.buildUpstreamWsTarget(
      {url: 'http://localhost:3005', username: 'alice', password: 'secret'},
      'dev-2',
      {allowQueryAuth: true},
    );
    assert.ok(compatTarget);
    const compatUrl = new URL(compatTarget.url);
    assert.equal(compatUrl.protocol, 'ws:');
    assert.equal(
      compatUrl.searchParams.get('authorization'),
      Buffer.from('alice:secret', 'utf8').toString('base64'),
    );
  });

  it('validates schedule timestamps & payloads consistently on server (DRY-01)', () => {
    const now = 1_700_000_000_000;
    const tooSoon = new Date(now + 10_000).toISOString();
    assert.throws(
      () => schedSvc.validateScheduleTimestamp(tooSoon, now),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );

    const validTime = new Date(now + 120_000).toISOString();
    const payload = schedSvc.validateAndBuildSchedulePayload(
      {
        message: '  Hello  ',
        scheduled_at: validTime,
        recurrence: 'weekly',
        weekdays: [1, 3, 1],
        // P1-21 (Phase 2, Path C): a recurrence must end — the pre-existing
        // fixture now carries an end date so it still exercises the valid
        // path; open-ended recurrences are covered by
        // tests/phase2-device-recurrence.test.ts.
        end_at: new Date(now + 7 * 86_400_000).toISOString(),
      },
      {fixedPhone: '966500000000@s.whatsapp.net', nowMs: now},
    );
    assert.equal(payload.phone, '966500000000@s.whatsapp.net');
    assert.equal(payload.message, 'Hello');
    assert.deepEqual(payload.weekdays, [1, 3]);
  });

  it('validates client schedule fields and participant lists consistently (DRY-01)', () => {
    const now = 1_700_000_000_000;
    const pastIso = schedUtils.toLocalDateTimeInput(new Date(now + 20_000));
    assert.throws(() => schedUtils.validateScheduleFutureMs(pastIso, now));

    const futureLocal = schedUtils.toLocalDateTimeInput(new Date(now + 5 * 60_000));
    const fields = schedUtils.validateAndBuildScheduleFields(
      {
        message: 'Reminder',
        scheduledAtLocal: futureLocal,
        timezone: 'UTC',
        recurrence: 'once',
        weekdays: [],
        dayOfMonth: '1',
        occurrenceLimit: '2',
        endAtLocal: '',
      },
      {pastTime: 'past', invalidEndAt: 'invalid_end', recurrenceEndRequired: 'recurrence_end'},
      now,
    );
    assert.equal(fields.message, 'Reminder');
    assert.equal(fields.occurrence_limit, 2);

    assert.deepEqual(participantsMod.parseParticipantsList('96651, 96652;\n96653'), [
      '96651',
      '96652',
      '96653',
    ]);
  });
});
