// SPDX-License-Identifier: EUPL-1.2
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient, ErganiError } from '../src/ergani/client.js';
import { OutOfWindowError, type ReadClient } from '../src/ergani/exbase.js';
import { pullCommand, runArchive, runPull } from '../src/records/cli.js';
import { PastRetentionError, RealmMismatchError, daysOf, describePull, previousMonth, pullMonth } from '../src/records/pull.js';
import {
  EmployerMismatchError,
  daysRead,
  heldSchedule,
  heldStamps,
  recordMigrations,
  openRecordStore,
  pullLog,
  type RecordStore,
} from '../src/records/store.js';
import {
  FAKE_CREDENTIAL,
  FAKE_EMPLOYER_AFM,
  MEASURED_NOW,
  SAMPLE_SCHEDULE,
  SAMPLE_STAMPS,
  fakeClientConfig,
  startErganiFake,
  type ErganiFake,
  type ErganiFakeOptions,
} from './fake/ergani-fake.js';
import { AFM } from './fixtures/people.js';

/**
 * The record store and the monthly pull. The pull runs against the ministry-derived fake (the whole month, end to
 * end) and against a stub client (the failures the fake does not produce).
 * ⛔ Every ΑΦΜ is a ministry example value (they fail the check digit) or fabricated. No test reaches ΕΡΓΑΝΗ.
 */

const AUGUST = { from: '2026-08-01', to: '2026-08-31' };
/** Another employer than the fake's: a nine-digit string that fails the check digit, so no real one. */
const OTHER_EMPLOYER = '012345679';
const count = (db: RecordStore, table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

let fakes: ErganiFake[] = [];
let stores: RecordStore[] = [];
let cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  for (const db of stores) if (db.isOpen) db.close();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  fakes = [];
  stores = [];
  cleanupDirs = [];
});

function store(path = ':memory:'): RecordStore {
  const db = openRecordStore(path);
  stores.push(db);
  return db;
}

async function fakeClient(options: ErganiFakeOptions = {}) {
  const fake = await startErganiFake(options);
  fakes.push(fake);
  return { fake, client: new ErganiClient(fakeClientConfig(fake), { now: options.now ?? (() => MEASURED_NOW) }) };
}

const executed = (fake: ErganiFake) => fake.requests.filter((r) => r.route === 'WebServices/ExecuteService');

describe('the schema: numbered, forward-only migrations', () => {
  it('applies to an empty database — every migration once, recorded, and the record tables exist', () => {
    const db = store();
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: '001-the-record.sql' },
    ]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t['name']);
    expect(tables).toEqual(['day_reads', 'employer', 'pulls', 'schedule', 'schedule_sightings', 'schema_migrations', 'stamp_sightings', 'stamps']);
  });

  it('reopening a store applies nothing twice, and the record is still there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ergani-records-'));
    try {
      const path = join(dir, 'records.sqlite');
      const { client } = await fakeClient();
      const first = openRecordStore(path);
      await pullMonth(first, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
      first.close();

      const again = store(path);
      expect(again.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
      expect(heldStamps(again, AUGUST.from, AUGUST.to)).toHaveLength(2);
      expect(pullLog(again)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a store written by newer code, rather than writing to it under an older schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ergani-records-'));
    try {
      const path = join(dir, 'records.sqlite');
      const newer = [...recordMigrations(), { version: 2, name: '002-from-the-future.sql', sql: 'CREATE TABLE later (x TEXT)' }];
      openRecordStore(path, newer).close();
      expect(() => openRecordStore(path)).toThrow(/002-from-the-future\.sql.*newer code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('⛔ the record never loses a row', () => {
  it('every table of the record refuses DELETE and UPDATE — so no code path can remove or rewrite a row', async () => {
    const db = store();
    const { client } = await fakeClient();
    await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations') AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => String(t['name']));
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      const before = count(db, table);
      expect(before, table).toBeGreaterThan(0);
      const refusal = table === 'employer' ? /belongs to one employer/ : /append-only/;
      expect(() => db.exec(`DELETE FROM ${table}`), table).toThrow(refusal);
      expect(() => db.exec(`UPDATE ${table} SET rowid = rowid`), table).toThrow(refusal);
      expect(count(db, table), table).toBe(before);
    }
  });

  it('refuses INSERT OR REPLACE, which would delete the row it replaces', async () => {
    const db = store();
    const { client } = await fakeClient();
    await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    expect(() =>
      db.exec(
        `INSERT OR REPLACE INTO stamps (branch, day, afm, date, hour_from, hour_to, ends_next_day, first_pull_id)
         SELECT branch, day, afm, date, hour_from, hour_to, ends_next_day, first_pull_id FROM stamps LIMIT 1`,
      ),
    ).toThrow(/append-only/);
    expect(count(db, 'stamps')).toBe(2);
  });
});

describe('the monthly pull, against the ministry-derived fake', () => {
  it('pulls the previous Athens month — every day, both services — into the record, and logs it', async () => {
    const db = store();
    const { fake, client } = await fakeClient();
    const report = await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });

    // 31 days × (EX_BASE_07 + EX_BASE_08), each date asked once, in day order, 07 before 08.
    const asked = executed(fake).map((r) => {
      const body = JSON.parse(r.body) as { ServiceCode: string; Parameters: Array<{ ParameterValue: string }> };
      return `${body.ServiceCode} ${body.Parameters[0]?.ParameterValue}`;
    });
    expect(asked).toHaveLength(62);
    expect(asked.slice(0, 3)).toEqual(['EX_BASE_07 01/08/2026', 'EX_BASE_08 01/08/2026', 'EX_BASE_07 02/08/2026']);
    expect(asked.at(-1)).toBe('EX_BASE_08 31/08/2026');
    expect(fake.requests.map((r) => r.route).filter((r) => r !== 'WebServices/ExecuteService')).toEqual([
      'Authentication',
      'WebServices/ServicesList',
    ]);

    expect(report).toMatchObject({
      month: '2026-08',
      realm: 'local',
      branch: '0',
      outcome: 'complete',
      stampRows: 2,
      scheduleRows: 6,
      newStampRows: 2,
      newScheduleRows: 6,
      stampsNoLongerAnswered: 0,
      scheduleNoLongerAnswered: 0,
      failedReads: [],
      stops: [],
      readsNeeded: 62,
      readsAttempted: 62,
      startedAt: '2026-09-24T07:00:00.000Z',
    });
    const { failedReads: _f, stops: _s, readsNeeded: _n, readsAttempted: _a, ...logged } = report;
    expect(pullLog(db)).toEqual([logged]);

    expect(heldStamps(db, AUGUST.from, AUGUST.to)).toEqual([
      { branch: '0', day: '2026-08-28', afm: '000000000', date: '28/08/2026', hourFrom: '17:00', hourTo: '00:30', endsNextDay: true, firstPullId: report.id, inLatestRead: 1 },
      { branch: '0', day: '2026-08-31', afm: '000000000', date: '31/08/2026', hourFrom: '08:00', hourTo: '16:00', endsNextDay: false, firstPullId: report.id, inLatestRead: 1 },
    ]);
    const schedule = heldSchedule(db, AUGUST.from, AUGUST.to);
    expect(schedule).toHaveLength(6);
    // A leave row as measured 2026-09-28 — no hour fields, no Extra — held with '' for each.
    expect(schedule).toContainEqual({
      branch: '0',
      day: '2026-08-31',
      afm: '999999999',
      type: 'ΑΔΠΠΜ',
      hourFrom: '',
      hourTo: '',
      breakMinutes: '15',
      breakInWork: '0',
      extra: '',
      firstPullId: report.id,
      inLatestRead: 1,
    });
    // What each read answered, per service per day.
    expect(db.prepare('SELECT count(*) AS n FROM day_reads WHERE rows IS NOT NULL').get()?.['n']).toBe(62);
    expect(db.prepare("SELECT rows FROM day_reads WHERE service = 'EX_BASE_08' AND day = '2026-08-28'").get()).toEqual({ rows: 3 });
  });

  it('re-pulling the same month duplicates nothing: the rows are sighted again, not stored again', async () => {
    const db = store();
    const { client } = await fakeClient();
    const first = await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    const second = await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });

    expect(second).toMatchObject({ outcome: 'complete', stampRows: 2, scheduleRows: 6, newStampRows: 0, newScheduleRows: 0 });
    expect(second.stampsNoLongerAnswered + second.scheduleNoLongerAnswered).toBe(0);
    expect(count(db, 'stamps')).toBe(2);
    expect(count(db, 'schedule')).toBe(6);
    expect(count(db, 'stamp_sightings')).toBe(4);
    expect(count(db, 'schedule_sightings')).toBe(12);
    for (const row of [...heldStamps(db, AUGUST.from, AUGUST.to), ...heldSchedule(db, AUGUST.from, AUGUST.to)]) {
      expect(row.firstPullId).toBe(first.id);
      expect(row.inLatestRead).toBe(1);
    }
    expect(pullLog(db).map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it('a month changed upstream: the corrected row is added, the old one KEPT, and the two told apart', async () => {
    const db = store();
    const original = await fakeClient();
    const first = await pullMonth(db, original.client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });

    // In November the accountant re-declared: the 31st ended at 17:00, and the 28th no longer answers.
    const corrected = await fakeClient({
      stamps: { '31/08/2026': [{ ...SAMPLE_STAMPS['31/08/2026']![0]!, HourTo: '17:00' }] },
      schedule: { ...SAMPLE_SCHEDULE, '28/08/2026': SAMPLE_SCHEDULE['28/08/2026']!.slice(0, 1) },
    });
    const second = await pullMonth(db, corrected.client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    expect(second).toMatchObject({
      outcome: 'complete',
      stampRows: 1,
      newStampRows: 1,
      stampsNoLongerAnswered: 2,
      scheduleRows: 4,
      newScheduleRows: 0,
      scheduleNoLongerAnswered: 2,
    });

    const held = heldStamps(db, AUGUST.from, AUGUST.to).map((r) => [r.day, r.hourTo, r.firstPullId, r.inLatestRead]);
    expect(held).toEqual([
      ['2026-08-28', '00:30', first.id, 0],
      ['2026-08-31', '16:00', first.id, 0],
      ['2026-08-31', '17:00', second.id, 1],
    ]);
    const leave = heldSchedule(db, AUGUST.from, AUGUST.to).filter((r) => r.day === '2026-08-28' && r.type === 'ΑΔΠΠΜ');
    expect(leave.map((r) => r.inLatestRead)).toEqual([0]);
    expect(describePull(second).join('\n')).toContain('no longer in ΕΡΓΑΝΗ’s answer');

    // And back again: the original rows are sighted anew, nothing is stored twice.
    const third = await pullMonth(db, original.client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    expect(third).toMatchObject({ newStampRows: 0, newScheduleRows: 0, stampsNoLongerAnswered: 1, scheduleNoLongerAnswered: 0 });
    expect(heldStamps(db, AUGUST.from, AUGUST.to).map((r) => [r.hourTo, r.inLatestRead])).toEqual([
      ['00:30', 1],
      ['16:00', 1],
      ['17:00', 0],
    ]);
    expect(count(db, 'stamps')).toBe(3);
  });

  it('a month with ZERO stamps is logged plainly — a finding, not a non-event', async () => {
    const db = store();
    const { client } = await fakeClient();
    const report = await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month: '2026-07' });
    expect(report).toMatchObject({ month: '2026-07', outcome: 'complete', stampRows: 0, scheduleRows: 0, readsAttempted: 62 });
    expect(pullLog(db)).toEqual([expect.objectContaining({ month: '2026-07', outcome: 'complete', stampRows: 0 })]);
    expect(describePull(report).join('\n')).toContain('ZERO stamp rows for the whole of 2026-07');

    const august = await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month: '2026-08' });
    expect(describePull(august).join('\n')).not.toContain('ZERO');
  });

  it('says what it did in counts and days — never an ΑΦΜ or an hour', async () => {
    const db = store();
    const { client } = await fakeClient();
    const text = describePull(await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM })).join('\n');
    expect(text).toContain('2 row(s) answered');
    for (const value of ['000000000', '999999999', '08:00', '16:00', '00:30']) expect(text).not.toContain(value);
  });

  it('refuses this month before anything is sent or logged — ΕΡΓΑΝΗ cannot answer it yet', async () => {
    const db = store();
    const { fake, client } = await fakeClient();
    await expect(pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month: '2026-09' })).rejects.toBeInstanceOf(OutOfWindowError);
    await expect(pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month: '2026-8' })).rejects.toBeInstanceOf(RangeError);
    expect(fake.requests).toEqual([]);
    expect(pullLog(db)).toEqual([]);
  });

  it('takes "the previous month" on the Athens calendar: 00:30 on 1 October in Athens pulls September', async () => {
    const db = store();
    const now = () => Date.parse('2026-09-30T21:30:00Z');
    const { client } = await fakeClient({ now });
    await expect(pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM })).resolves.toMatchObject({ month: '2026-09', readsNeeded: 60 });
  });

  it('holds ONE realm: a store that has read one ΕΡΓΑΝΗ refuses a pull from another, sending nothing', async () => {
    const db = store();
    const { fake, client } = await fakeClient();
    await pullMonth(db, client, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    const sent = fake.requests.length;
    const err = await refusal(pullMonth(db, client, { realm: 'trial', employerAfm: FAKE_EMPLOYER_AFM }));
    expect(err).toBeInstanceOf(RealmMismatchError);
    expect((err as Error).message).toContain('holds pulls from local, and this client reads trial');
    expect(fake.requests).toHaveLength(sent);
    expect(pullLog(db)).toHaveLength(1);
  });

  it('holds ONE realm when two pulls overlap: the check is asked again inside the write', async () => {
    const db = store();
    const base = stub(everyDay);
    let other: Promise<unknown> | undefined;
    // While this pull walks, a pull from another realm is written into the same, empty store.
    const overlapped: ReadClient = {
      ...base,
      executeService: async (code, params) => {
        other ??= pullMonth(db, stub(everyDay), { realm: 'trial', employerAfm: FAKE_EMPLOYER_AFM });
        await other;
        return base.executeService(code, params);
      },
    };
    expect(await refusal(pullMonth(db, overlapped, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM }))).toBeInstanceOf(RealmMismatchError);
    expect(pullLog(db).map((p) => p.realm)).toEqual(['trial']);

    // And one employer, the same way: another employer's pull written while this one walks.
    const db2 = store();
    let stray: Promise<unknown> | undefined;
    const overlappedEmployer: ReadClient = {
      ...base,
      executeService: async (code, params) => {
        stray ??= pullMonth(db2, stub(everyDay), { realm: 'local', employerAfm: OTHER_EMPLOYER });
        await stray;
        return base.executeService(code, params);
      },
    };
    expect(await refusal(pullMonth(db2, overlappedEmployer, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM }))).toBeInstanceOf(
      EmployerMismatchError,
    );
    expect(pullLog(db2)).toHaveLength(1);
  });

  it('holds ONE employer: a store that has read one refuses another employer\'s pull, sending nothing', async () => {
    const db = store();
    await pullMonth(db, stub(everyDay), { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    let sent = 0;
    const stray: ReadClient = {
      ...stub(everyDay),
      listServices: async () => {
        sent += 1;
        return [];
      },
      executeService: async () => {
        sent += 1;
        return {};
      },
    };
    const err = await refusal(pullMonth(db, stray, { realm: 'local', employerAfm: OTHER_EMPLOYER }));
    expect(err).toBeInstanceOf(EmployerMismatchError);
    expect(sent).toBe(0);
    expect(pullLog(db)).toHaveLength(1);
    // The employer row is the database's own: never changed, never deleted.
    expect(() => db.exec('UPDATE employer SET afm = afm')).toThrow(/never changed/);
    expect(() => db.exec('DELETE FROM employer')).toThrow(/never deleted/);
  });

  it('holds EVERY branch of its employer: each branch pulls into the one store, and a day is read once all have read it', async () => {
    const db = store();
    await pullMonth(db, stub(everyDay), { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    const branchOne: ReadClient = { ...stub(everyDay), branchCode: '1' };
    await expect(pullMonth(db, branchOne, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM })).resolves.toMatchObject({
      branch: '1',
      outcome: 'complete',
    });
    expect(pullLog(db).map((p) => p.branch)).toEqual(['0', '1']);
    expect(new Set(heldStamps(db, AUGUST.from, AUGUST.to).map((s) => s.branch))).toEqual(new Set(['0', '1']));
    expect(daysRead(db, AUGUST.from, AUGUST.to).filter((d) => d.service === 'EX_BASE_07')).toHaveLength(62);
  });

  it('⛔ refuses any month six or more months back, pulled before or not — its unread days stay «not read»', async () => {
    const db = store();
    // September: the pull of August stops at the 10th — both services, the conversation failed.
    let down = false;
    await pullMonth(
      db,
      stub((code, date) => {
        if (code === 'EX_BASE_07' && date === '10/08/2026') down = true;
        return down ? new ErganiError(400, JSON.stringify({ message: REFUSAL }), 'ExecuteService') : everyDay(code, date);
      }),
      { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM },
    );
    const at = (iso: string): ReadClient => ({ ...stub(everyDay), now: () => Date.parse(iso) });

    // February 2027: August is six months back, July seven. ΕΡΓΑΝΗ may have deleted days of both, and an
    // empty answer would stand as «no stamp» for good. Refused — held or not — before anything is sent.
    let sent = 0;
    const late: ReadClient = {
      ...at('2027-02-01T12:00:00Z'),
      listServices: async () => {
        sent += 1;
        return [];
      },
      executeService: async () => {
        sent += 1;
        return {};
      },
    };
    for (const month of ['2026-08', '2026-07', '2025-01']) {
      expect(await refusal(pullMonth(db, late, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month })), month).toBeInstanceOf(PastRetentionError);
    }
    expect(sent).toBe(0);
    expect(pullLog(db)).toHaveLength(1);
    // The 10th–31st were never read, and still say so: «not read», never «no stamp».
    expect(daysRead(db, '2026-08-10', '2026-08-31')).toEqual([]);
    expect(heldStamps(db, AUGUST.from, AUGUST.to)).toHaveLength(9);

    // January 2027: five months back, inside ΕΡΓΑΝΗ's six — the stopped month is finished as usual.
    await expect(pullMonth(db, at('2027-01-31T12:00:00Z'), { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM, month: '2026-08' })).resolves.toMatchObject({
      outcome: 'complete',
      newStampRows: 22,
    });
  });
});

/**
 * A client that answers from a script, by service and `DD/MM/YYYY` date — for failures the fake never
 * produces. Anything not scripted answers a recognisable empty day.
 */
function stub(script: (code: string, date: string) => unknown = () => undefined): ReadClient {
  const declared = [
    { name: 'Dt', description: '', isRequired: true, type: 'Date', maxLength: 0 },
    { name: 'PararthmaAa', description: '', isRequired: true, type: 'Int', maxLength: 0 },
  ];
  return {
    listServices: async () => [
      { name: 'EX_BASE_07', description: '', parameters: declared },
      { name: 'EX_BASE_08', description: '', parameters: declared },
    ],
    executeService: async (code, params) => {
      const date = (params as { Parameters: Array<{ ParameterValue: string }> }).Parameters[0]?.ParameterValue ?? '';
      const answer = script(code, date);
      if (answer instanceof Error) throw answer;
      return answer ?? { [code]: {} };
    },
    now: () => MEASURED_NOW,
    branchCode: '0',
  };
}

const stampOn = (date: string, extra: Record<string, string> = {}) => ({
  Afm: '000000000',
  Date: date,
  HourFrom: '08:00',
  HourTo: '16:00',
  IsEndDateDifferentThanDate: '0',
  ...extra,
});
const everyDay = (code: string, date: string) => (code === 'EX_BASE_07' ? { EX_BASE_07: { Rows: [stampOn(date)] } } : undefined);
const REFUSAL = 'Κάτι δεν πήγε καλά';

describe('a read that fails — recorded, never read as an empty day', () => {
  it('a failed conversation STOPS the walk, keeps the days read, and logs what ΕΡΓΑΝΗ said, verbatim', async () => {
    const db = store();
    // From the stamps of the 10th on, ΕΡΓΑΝΗ refuses everything.
    let down = false;
    const failing = stub((code, date) => {
      if (code === 'EX_BASE_07' && date === '10/08/2026') down = true;
      return down ? new ErganiError(400, JSON.stringify({ message: REFUSAL }), 'ExecuteService') : everyDay(code, date);
    });
    const report = await pullMonth(db, failing, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });

    // Each service stops at its first failure: the stamps of the 10th, then the schedule of the 10th.
    expect(report).toMatchObject({ outcome: 'stopped', readsNeeded: 62, readsAttempted: 20, stampRows: 9, newStampRows: 9 });
    const stopped = ['EX_BASE_07', 'EX_BASE_08'].map((service) => ({ service, day: '2026-08-10', error: expect.stringContaining(REFUSAL) }));
    expect(report.failedReads).toEqual(stopped);
    expect(report.stops).toEqual(stopped);
    expect(pullLog(db)[0]?.outcome).toBe('stopped');
    expect(db.prepare('SELECT service, day, rows, error FROM day_reads ORDER BY rowid DESC LIMIT 1').get()).toEqual({
      service: 'EX_BASE_08',
      day: '2026-08-10',
      rows: null,
      error: expect.stringContaining(REFUSAL),
    });
    expect(count(db, 'day_reads')).toBe(20);
    const text = describePull(report).join('\n');
    expect(text).toContain('STOPPED at EX_BASE_07 for 2026-08-10');
    expect(text).toContain('STOPPED at EX_BASE_08 for 2026-08-10');
    expect(text).not.toContain('was not stopped by it');
    expect(text).toContain(REFUSAL);
    expect(text).toContain('42 of 62 reads were not attempted');

    // Once the cause is cleared, the re-run fills the month and stores nothing twice.
    const rerun = await pullMonth(db, stub(everyDay), { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    expect(rerun).toMatchObject({ outcome: 'complete', stampRows: 31, newStampRows: 22, stampsNoLongerAnswered: 0 });
    expect(count(db, 'stamps')).toBe(31);
  });

  it('a service this user is not offered stops only itself: every day of the stamps is still archived', async () => {
    const db = store();
    const base = stub(everyDay);
    const stampsOnly: ReadClient = {
      ...base,
      listServices: async () => ((await base.listServices()) as Array<{ name: string }>).filter((s) => s.name === 'EX_BASE_07'),
    };
    const report = await pullMonth(db, stampsOnly, { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    expect(report).toMatchObject({ outcome: 'stopped', readsAttempted: 32, stampRows: 31, newStampRows: 31, scheduleRows: 0 });
    expect(report.stops).toEqual([{ service: 'EX_BASE_08', day: '2026-08-01', error: expect.stringContaining('not in ServicesList') }]);
    expect(count(db, 'stamps')).toBe(31);
    const text = describePull(report).join('\n');
    expect(text).toContain('STOPPED at EX_BASE_08 for 2026-08-01');
    expect(text).toContain('EX_BASE_07 was not stopped by it');
    expect(text).toContain('30 of 62 reads were not attempted');
  });

  it('an answer the reader does not recognise is that ONE day’s problem: the walk goes on, the pull is incomplete', async () => {
    const db = store();
    const report = await pullMonth(
      db,
      stub((code, date) =>
        code === 'EX_BASE_07' && date === '15/08/2026'
          ? { EX_BASE_07: { Rows: [stampOn(date, { HourTo2: '19:00' })] } } // a second interval? (M1)
          : everyDay(code, date),
      ),
      { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM },
    );
    expect(report).toMatchObject({ outcome: 'incomplete', readsAttempted: 62, stampRows: 30 });
    expect(report.failedReads).toEqual([{ service: 'EX_BASE_07', day: '2026-08-15', error: expect.stringContaining('HourTo2') }]);
    expect(describePull(report).join('\n')).toContain('EX_BASE_07 for 2026-08-15 was not read');
    expect(heldStamps(db, '2026-08-15', '2026-08-15')).toEqual([]);
  });

  it('a day whose read failed never counts its held rows as no longer answered', async () => {
    const db = store();
    await pullMonth(db, stub(everyDay), { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM });
    const second = await pullMonth(
      db,
      stub((code, date) =>
        code === 'EX_BASE_07' && date === '31/08/2026' ? { EX_BASE_07: { Rows: [{ Unknown: '1' }] } } : everyDay(code, date),
      ),
      { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM },
    );
    expect(second).toMatchObject({ outcome: 'incomplete', stampsNoLongerAnswered: 0 });
    // The latest SUCCESSFUL read of the 31st is still the first pull's, and it listed the row.
    expect(heldStamps(db, '2026-08-31', '2026-08-31').map((r) => r.inLatestRead)).toEqual([1]);
  });

  it('identical rows in one answer are stored once and sighted with their count — never silently merged', async () => {
    const db = store();
    const report = await pullMonth(
      db,
      stub((code, date) =>
        code === 'EX_BASE_07' && date === '05/08/2026' ? { EX_BASE_07: { Rows: [stampOn(date), stampOn(date)] } } : undefined,
      ),
      { realm: 'local', employerAfm: FAKE_EMPLOYER_AFM },
    );
    expect(report).toMatchObject({ stampRows: 2, newStampRows: 1 });
    expect(heldStamps(db, AUGUST.from, AUGUST.to).map((r) => [r.day, r.inLatestRead])).toEqual([['2026-08-05', 2]]);
  });
});

describe('months and days', () => {
  it('the previous month, across a year end', () => {
    expect(previousMonth('2026-09-24')).toBe('2026-08');
    expect(previousMonth('2027-01-01')).toBe('2026-12');
  });

  it('every calendar day of a month, leap years included', () => {
    expect(daysOf('2026-08')).toHaveLength(31);
    expect(daysOf('2026-09').at(-1)).toBe('2026-09-30');
    expect(daysOf('2028-02').at(-1)).toBe('2028-02-29');
    expect(daysOf('2026-02').at(-1)).toBe('2026-02-28');
    for (const bad of ['2026-13', '2026-00', '2026-8', '08-2026', '']) expect(() => daysOf(bad), bad).toThrow(RangeError);
  });
});

describe('the CLI’s command line: one record, in one file', () => {
  it('needs ERGANI_RECORDS_DB, as an absolute path to a store that exists — or --init-store to create it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ergani-records-'));
    try {
      const existing = join(dir, 'records.sqlite');
      writeFileSync(existing, '');
      const missing = join(dir, 'typo.sqlite');

      expect(() => pullCommand([], {})).toThrow('ERGANI_RECORDS_DB is not set');
      expect(() => pullCommand([], { ERGANI_RECORDS_DB: 'records.sqlite' })).toThrow('must be an absolute path');
      expect(() => pullCommand([], { ERGANI_RECORDS_DB: missing })).toThrow('--init-store');
      expect(pullCommand(['--month', '2026-07'], { ERGANI_RECORDS_DB: existing })).toEqual({
        store: existing,
        month: '2026-07',
        branch: undefined,
        init: false,
      });
      expect(pullCommand(['--branch', '1'], { ERGANI_RECORDS_DB: existing })).toMatchObject({ branch: '1' });
      expect(() => pullCommand(['--purge'], { ERGANI_RECORDS_DB: existing })).toThrow();
      expect(() => pullCommand(['--new-store'], { ERGANI_RECORDS_DB: missing })).toThrow();

      // --init-store: only where there is no file yet, and never alongside a month or a branch.
      expect(pullCommand(['--init-store'], { ERGANI_RECORDS_DB: missing })).toEqual({ store: missing, month: undefined, branch: undefined, init: true });
      expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: existing })).toThrow('never touches one');
      expect(() => pullCommand(['--init-store', '--month', '2026-07'], { ERGANI_RECORDS_DB: missing })).toThrow('takes neither');
      expect(() => pullCommand(['--init-store', '--branch', '1'], { ERGANI_RECORDS_DB: missing })).toThrow('takes neither');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⛔ keeps the store outside EVERY code folder, however the path is spelled — links followed', () => {
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'ergani-records-'));
    const refused = 'ERGANI_RECORDS_DB is inside a code folder';
    try {
      // This code folder, however deep, whether or not the folder exists yet.
      for (const inside of [join(repo, 'records.db'), join(repo, 'test', 'records.sqlite3'), join(repo, 'no', 'such', 'dir', 'r.db')]) {
        expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: inside }), inside).toThrow(refused);
      }
      // ANOTHER code folder: a main checkout (`.git` a directory) and a worktree (`.git` a file).
      const checkout = join(dir, 'another-checkout');
      mkdirSync(join(checkout, '.git'), { recursive: true });
      const worktree = join(dir, 'a-worktree');
      mkdirSync(worktree);
      writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
      for (const inside of [join(checkout, 'records.db'), join(checkout, 'exports', 'new', 'records.db'), join(worktree, 'records.db')]) {
        expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: inside }), inside).toThrow(refused);
      }
      // A link from outside that leads into one is inside.
      const link = join(dir, 'into-the-code');
      symlinkSync(join(repo, 'src'), link);
      expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: join(link, 'records.db') })).toThrow(refused);
      // A link to nothing cannot be judged.
      const dangling = join(dir, 'dangling.db');
      symlinkSync(join(dir, 'nowhere', 'records.db'), dangling);
      expect(() => pullCommand([], { ERGANI_RECORDS_DB: dangling })).toThrow('cannot be checked');
      // A trailing «/» changes nothing: the last link is still resolved — or refused.
      expect(() => pullCommand([], { ERGANI_RECORDS_DB: `${dangling}/` })).toThrow('cannot be checked');
      const intoAFile = join(dir, 'into-a-file');
      symlinkSync(join(repo, 'package.json'), intoAFile);
      expect(() => pullCommand([], { ERGANI_RECORDS_DB: `${intoAFile}/` })).toThrow(refused);
      // «..» is refused: the system takes it after the link, not before.
      expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: `${link}/../records.db` })).toThrow('without «.» or «..»');
      // Outside every code folder, as before.
      expect(pullCommand(['--init-store'], { ERGANI_RECORDS_DB: join(dir, 'records.db') })).toMatchObject({ store: join(dir, 'records.db') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⓘ Only where the disk ignores capitals, or has another name for the same folder (the Mac; Linux CI
  // has neither, and there these cannot fail).
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const otherCase = repo.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  it.runIf(otherCase !== repo && existsSync(otherCase))('⛔ a code folder typed in other capitals is still a code folder', () => {
    expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: join(otherCase, 'records.db') })).toThrow(
      'ERGANI_RECORDS_DB is inside a code folder',
    );
  });
  const dataVolume = join('/System/Volumes/Data', repo);
  it.runIf(existsSync(dataVolume))('⛔ a code folder by the Mac’s other name for it is still a code folder', () => {
    expect(() => pullCommand(['--init-store'], { ERGANI_RECORDS_DB: join(dataVolume, 'records.db') })).toThrow(
      'ERGANI_RECORDS_DB is inside a code folder',
    );
  });
});

describe('`ergani pull` — the settings reach the reads, end to end against the fake', () => {
  it('a branch the settings say declares no standing schedule (SCHEDULE=none) is read complete; unsaid, it is not', async () => {
    // ΕΡΓΑΝΗ answers this branch's EX_BASE_08 with a bare `null` (measured), and the fake does the same.
    // `ergani pull` reads last month by the real clock, so the fake runs on it too.
    const fake = await startErganiFake({ now: Date.now, employerAfm: AFM.employer, noScheduleDeclared: ['0'] });
    fakes.push(fake);
    const dir = mkdtempSync(join(tmpdir(), 'ergani-pull-'));
    cleanupDirs.push(dir);
    const env: NodeJS.ProcessEnv = {
      ERGANI_RECORDS_DB: join(dir, 'records.sqlite'),
      ERGANI_EMPLOYER_AFM: fake.employerAfm,
      ERGANI_BRANCH_0_USERNAME: FAKE_CREDENTIAL.username,
      ERGANI_BRANCH_0_PASSWORD: FAKE_CREDENTIAL.password,
      ERGANI_USERTYPE: FAKE_CREDENTIAL.usertype,
      ERGANI_BASE_URL: fake.baseUrl,
    };
    const lines: string[] = [];
    const out = (line: string) => void lines.push(line);
    expect(await runPull(['--init-store'], env, out)).toBe(0);
    expect(await runPull([], env, out)).toBe(1);
    expect(await runPull([], { ...env, STAMP_BRANCH_0_SCHEDULE: 'none' }, out)).toBe(0);

    // The daily run, once, from last month: «up» only when the settings say so.
    const lastMonth = previousMonth(new Date().toISOString().slice(0, 10));
    const daily = { ...env, ARCHIVE_FROM: lastMonth, ERGANI_EXPORTS_DIR: join(dir, 'exports') };
    const fresh = (name: string) => ({ ...daily, ERGANI_RECORDS_DB: join(dir, `${name}.sqlite`) });
    for (const name of ['unsaid', 'said']) expect(await runPull(['--init-store'], fresh(name), out)).toBe(0);
    expect(await runArchive(['--once'], fresh('unsaid'), out)).toBe(1);
    expect(await runArchive(['--once'], { ...fresh('said'), STAMP_BRANCH_0_SCHEDULE: 'none' }, out)).toBe(0);
    // Each run notes its start beside the record — what a restart in clinic hours is judged on (`dueAtStart`).
    for (const name of ['unsaid', 'said']) expect(existsSync(join(dir, `${name}.sqlite.last-run`))).toBe(true);
  });
});
