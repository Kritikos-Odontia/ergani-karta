// SPDX-License-Identifier: EUPL-1.2
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '../src/config.js';
import { ErganiClient } from '../src/ergani/client.js';
import { ENARXI, LIXI, type ScheduleRow } from '../src/ergani/types.js';
import { adminCommand } from '../src/stamp/admin.js';
import { Alarms, cardAlarms, forgotAlarms, proofAlarms } from '../src/stamp/alarms.js';
import { athensInstant } from '../src/stamp/athens.js';
import { capturePunch } from '../src/stamp/capture.js';
import { loadStampSettings } from '../src/stamp/config.js';
import { ntfySender, withoutAfm, type Push } from '../src/stamp/notify.js';
import { EVIDENCE_DELAYS_MS, LAST_SEND_MS, Outbox, decide, stateOfPunch } from '../src/stamp/outbox.js';
import { createStampServer } from '../src/stamp/server.js';
import { createEnrollment } from '../src/stamp/devices.js';
import { declaredDays, ensureSchedule, markQuietDay, sourceDayFor } from '../src/stamp/schedule.js';
import { addPerson, checkPin, chooseOwnPin, type VerifiedPerson } from '../src/stamp/staff.js';
import { initStampStore, type Instance, type StampStore } from '../src/stamp/store.js';
import type { ReadClient } from '../src/ergani/exbase.js';
import { AFM, ALFA, VITA } from './fixtures/people.js';
import { addPersonForTest, deviceAt, outboxFor } from './fixtures/staff.js';
import { branchLogin, fakeBranchConfig, fakeClientConfig, startErganiFake, type ErganiFake, type FakeScheduleRow } from './fake/ergani-fake.js';

/**
 * THE ALARMS — who is due, who forgot, which card did not go through — on the page and to the owner's phone.
 * ⛔ Fabricated ΑΦΜ and names; the fake ΕΡΓΑΝΗ; a fake push receiver. No push leaves 127.0.0.1.
 */

const STRANGER = AFM.gamma;
/** One branch, the seat, reading ΕΡΓΑΝΗ's schedule — the employer of every test here but the two-branch one. */
const ONE = [{ code: '0', label: '', fromSchedule: true }];
const readersOf = (reader: ReadClient | undefined): ReadonlyMap<string, ReadClient> =>
  reader === undefined ? new Map() : new Map([['0', reader]]);
// Monday 5/10/2026 — its stand-in is Monday 28/9, the last Monday ΕΡΓΑΝΗ answers for.
const MONDAY = '2026-10-05';
const at = (time: string) => athensInstant(MONDAY, time);

let clock = at('07:00');
const now = () => clock;
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
  clock = at('07:00');
});

const work = (afm: string, from = '09:00:00', to = '17:00:00'): FakeScheduleRow => ({
  aa: '0', Afm: afm, Date: '28/09/2026', Type: 'ΕΡΓ', HourFrom: from, HourTo: to, Extra: null, BreakMinutes: '15', BreakInWork: '0',
});
const leave = (afm: string): FakeScheduleRow => ({ aa: '0', Afm: afm, Date: '28/09/2026', Type: 'ΑΔΠΠΜ', BreakMinutes: '15', BreakInWork: '0' });

async function setup(
  schedule: readonly FakeScheduleRow[] = [work(ALFA.afm), work(VITA.afm), leave(VITA.afm)],
  { live = true }: { live?: boolean } = {},
) {
  const fake: ErganiFake = await startErganiFake({ now, schedule: { '28/09/2026': schedule } });
  cleanup.push(() => fake.close());
  const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
  const db: StampStore = initStampStore(':memory:', instance, ['0'], 'now');
  cleanup.push(() => db.close());
  const client = new ErganiClient(fakeClientConfig(fake), { now });
  const device = deviceAt(db);
  if (live) {
    // The employer went live on an earlier day: the «forgot to stamp» alarms start with the first card on the page.
    // A fabricated person no longer on the list (id 0, so every test's people keep ids 1, 2…), and a card already
    // settled, so no alarm of the day sees either.
    db.prepare(
      "INSERT INTO employees (id, afm, surname, first_name, display_name, must_stamp, exempt_reason, active) VALUES (0, '999999998', 'ΠΑΛΙΑ', 'ΚΑΡΤΑ', 'Παλιά', 0, 'δοκιμή', 0)",
    ).run();
    const first = db
      .prepare(
        `INSERT INTO punches (employee_id, afm, surname, first_name, branch, f_type, reference_date, f_date, event_ms, device_id, created_at)
         VALUES (0, '999999998', 'ΠΑΛΙΑ', 'ΚΑΡΤΑ', '0', '0', '2026-09-28', '2026-09-28T09:00:00+03:00', ?, ?, 'x') RETURNING id`,
      )
      .get(athensInstant('2026-09-28', '09:00'), device.id);
    db.prepare("INSERT INTO decisions (punch_id, kind, by_label, at_ms) VALUES (?, 'covered', 'test', ?)").run(Number(first?.['id']), clock);
  }
  const pushes: Push[] = [];
  let failing = false;
  let off = false;
  const send = async (push: Push) => {
    if (off) return 'off' as const;
    if (failing) throw new Error('the push server answered HTTP 502');
    pushes.push(push);
  };
  const alarms = new Alarms({ db, branches: ONE, readers: readersOf(client), send, now, title: 'ΕΡΓΑΝΗ — Δοκιμή', log: () => undefined });
  const outbox = outboxFor({ db, client, instance, now, log: () => undefined });
  return { fake, db, client, device, pushes, alarms, outbox, instance, fail: (v: boolean) => (failing = v), switchOff: (v: boolean) => (off = v) };
}

async function person(db: StampStore, who: typeof ALFA, pin = '2580'): Promise<VerifiedPerson> {
  const { id, oneTimePin } = await addPersonForTest(db, who, 'test', clock);
  const first = await checkPin(db, id, oneTimePin!, clock);
  if (first.kind !== 'ok') throw new Error('PIN');
  const own = await chooseOwnPin(db, first.person, pin, clock);
  if (!own.ok) throw new Error(own.problem);
  return own.person;
}

const keys = (lines: Array<{ key: string }>) => lines.map((l) => l.key.split(':')[0]);

describe('who is due today — ΕΡΓΑΝΗ\'s schedule, a month late by the ministry\'s rule', () => {
  it('asks for the same weekday in the latest week ΕΡΓΑΝΗ will answer', () => {
    expect(sourceDayFor('2026-10-02')).toBe('2026-09-25'); // Fri → Fri
    expect(sourceDayFor('2026-10-05')).toBe('2026-09-28'); // Mon → Mon
    expect(sourceDayFor('2026-10-31')).toBe('2026-09-26'); // Sat → Sat
    expect(sourceDayFor('2026-11-01')).toBe('2026-10-25'); // Sun → Sun
    expect(sourceDayFor('2027-01-04')).toBe('2026-12-28'); // across the year
  });

  it('reads a declared day off as off, even beside the ordinary hours; a split shift as its two intervals', () => {
    const rows = [work(ALFA.afm, '09:00:00', '13:00:00'), work(ALFA.afm, '17:00:00', '21:00:00'), work(VITA.afm), leave(VITA.afm)];
    const parsed = rows.map((r) => ({ ...r, HourFrom: r.HourFrom ?? '', HourTo: r.HourTo ?? '', Extra: '' })) as ScheduleRow[];
    expect(declaredDays(parsed)).toEqual([
      { afm: ALFA.afm, off: false, intervals: [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }] },
      { afm: VITA.afm, off: true, intervals: [] },
    ]);
  });

  it('reads once a day, and after a failure asks again only every 15 minutes', async () => {
    const { db, client, fake } = await setup();
    const executed = () => fake.requests.filter((r) => r.route === 'WebServices/ExecuteService').length;
    expect((await ensureSchedule(db, client, clock))?.sourceDay).toBe('2026-09-28');
    await ensureSchedule(db, client, clock + 60_000);
    expect(executed()).toBe(1);

    const broken = new ErganiClient(fakeClientConfig(fake, { erganiPassword: new Secret('Wrong.pass1') }), { now });
    const db2 = initStampStore(':memory:', { name: 'other', realm: 'local', employerAfm: fake.employerAfm }, ['0'], 'now');
    cleanup.push(() => db2.close());
    expect(await ensureSchedule(db2, broken, clock)).toBeUndefined();
    expect(await ensureSchedule(db2, broken, clock + 14 * 60_000)).toBeUndefined();
    const reads = () => Number(db2.prepare('SELECT count(*) AS n FROM schedule_reads').get()?.['n']);
    expect(reads()).toBe(1);
    await ensureSchedule(db2, broken, clock + 15 * 60_000);
    expect(reads()).toBe(2);
  });
});

describe('someone forgot to stamp', () => {
  it('stays silent until the employer\'s first card on the page — then watches everyone from that day', async () => {
    const { db, client, device, alarms, pushes } = await setup([work(ALFA.afm), work(VITA.afm)], { live: false });
    const alfa = await person(db, ALFA);
    await person(db, VITA, '1397');
    await ensureSchedule(db, client, clock);
    // Installed, staff still on CardScanner: nothing on the desk, nothing to the phone — all day.
    expect(forgotAlarms(db, at('21:30'), 't', ONE)).toEqual([]);
    clock = at('21:30');
    await alarms.tick();
    expect(pushes).toEqual([]);
    // The go-live morning, replayed: the first real card, and from then on the others are held to the schedule.
    capturePunch(db, alfa, ENARXI, device, at('09:05'));
    expect(forgotAlarms(db, at('09:20'), 't', ONE).map((l) => l.key)).toEqual([`no-start:2:${MONDAY}:0:0`]);
  });

  it('no ΕΝΑΡΞΗ by the declared start + 20′ — named; gone once she stamps; never for someone on leave', async () => {
    const { db, client, device } = await setup();
    const alfa = await person(db, ALFA);
    await person(db, VITA, '1397');
    await ensureSchedule(db, client, clock);
    clock = at('09:19');
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    clock = at('09:20');
    const lines = forgotAlarms(db, clock, 't', ONE);
    expect(lines.map((l) => l.desk?.text)).toEqual(['Άλφα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 09:00).']);
    capturePunch(db, alfa, ENARXI, device, clock);
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
  });

  it('phone alerts switched off: the alarm is neither sent nor failed (no amber line) — and reaches the phone once they are on', async () => {
    const { db, client, alarms, pushes, switchOff } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    switchOff(true);
    clock = at('09:20');
    await alarms.tick();
    expect(pushes).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM pushes').get()?.['n']).toBe(0);
    expect(alarms.deskWarnings(clock).map((w) => w.text).join(' ')).not.toMatch(/κινητό/);
    switchOff(false);
    clock = at('09:25');
    await alarms.tick();
    expect(pushes.map((p) => p.message)).toEqual([expect.stringContaining('Άλφα')]);
  });

  it('a closed day raises no «has not stamped in» — and a mistaken mark can be withdrawn', async () => {
    const { db, client } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    markQuietDay(db, MONDAY, true, '28η Οκτωβρίου (δοκιμή)', 'test', clock);
    clock = at('12:00');
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    markQuietDay(db, MONDAY, false, 'ανοίξαμε τελικά', 'test', clock);
    expect(keys(forgotAlarms(db, clock, 't', ONE))).toEqual(['no-start']);
    expect(() => db.exec('DELETE FROM quiet_days')).toThrow();
  });

  it('a split shift is two intervals: a forgotten noon ΛΗΞΗ and a forgotten afternoon ΕΝΑΡΞΗ each raise their own alarm', async () => {
    const { db, client, device } = await setup([work(ALFA.afm, '09:00:00', '13:00:00'), work(ALFA.afm, '17:00:00', '21:00:00')]);
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    capturePunch(db, alfa, ENARXI, device, at('09:00'));
    expect(forgotAlarms(db, at('13:29'), 't', ONE)).toEqual([]);
    expect(forgotAlarms(db, at('13:30'), 't', ONE).map((l) => l.desk?.text)).toEqual([
      'Άλφα — δεν έχει χτυπήσει κάρτα ΛΗΞΗΣ (ΕΝΑΡΞΗ 09:00, βάρδια ως 13:00).',
    ]);
    capturePunch(db, alfa, LIXI, device, at('13:35'));
    expect(forgotAlarms(db, at('17:19'), 't', ONE)).toEqual([]);
    expect(forgotAlarms(db, at('17:20'), 't', ONE).map((l) => l.desk?.text)).toEqual([
      'Άλφα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 17:00).',
    ]);
    capturePunch(db, alfa, ENARXI, device, at('17:21'));
    expect(forgotAlarms(db, at('21:29'), 't', ONE)).toEqual([]);
    expect(forgotAlarms(db, at('21:30'), 't', ONE).map((l) => l.key)).toEqual([`no-end:1:${MONDAY}:0:1`]);
  });

  it('a split shift is matched by TIME: a second morning ΕΝΑΡΞΗ, or an errand out and back, never hides a forgotten afternoon ΕΝΑΡΞΗ', async () => {
    const split = (afm: string) => [work(afm, '09:00:00', '13:00:00'), work(afm, '17:00:00', '21:00:00')];
    const { db, client, device } = await setup([...split(ALFA.afm), ...split(VITA.afm)]);
    const alfa = await person(db, ALFA);
    const vita = await person(db, VITA, '1397');
    await ensureSchedule(db, client, clock);
    capturePunch(db, alfa, ENARXI, device, at('09:00'));
    capturePunch(db, alfa, ENARXI, device, at('09:01'));
    capturePunch(db, alfa, LIXI, device, at('13:00'));
    capturePunch(db, vita, ENARXI, device, at('09:00'));
    capturePunch(db, vita, LIXI, device, at('10:00'));
    capturePunch(db, vita, ENARXI, device, at('10:30'));
    capturePunch(db, vita, LIXI, device, at('13:00'));
    expect(forgotAlarms(db, at('17:19'), 't', ONE)).toEqual([]);
    expect(forgotAlarms(db, at('17:20'), 't', ONE).map((l) => l.key)).toEqual([`no-start:1:${MONDAY}:0:1`, `no-start:2:${MONDAY}:0:1`]);
    capturePunch(db, alfa, ENARXI, device, at('17:25'));
    expect(forgotAlarms(db, at('17:26'), 't', ONE).map((l) => l.key)).toEqual([`no-start:2:${MONDAY}:0:1`]);
  });

  it('an extra stint after the declared shift, left open, is still caught — after the shift\'s end, from 21:00', async () => {
    const { db, client, device } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    capturePunch(db, alfa, ENARXI, device, at('09:00'));
    capturePunch(db, alfa, LIXI, device, at('17:00'));
    capturePunch(db, alfa, ENARXI, device, at('18:00'));
    expect(forgotAlarms(db, at('20:59'), 't', ONE)).toEqual([]);
    expect(forgotAlarms(db, at('21:00'), 't', ONE).map((l) => l.key)).toEqual([`no-end:1:${MONDAY}:late`]);
  });

  it('an open ΕΝΑΡΞΗ at the declared end + 30′, or at 21:00 when no end is known', async () => {
    const { db, client, device } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    capturePunch(db, alfa, ENARXI, device, at('09:02'));
    clock = at('17:29');
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    clock = at('17:30');
    expect(forgotAlarms(db, clock, 't', ONE).map((l) => l.desk?.text)).toEqual([
      'Άλφα — δεν έχει χτυπήσει κάρτα ΛΗΞΗΣ (ΕΝΑΡΞΗ 09:02, βάρδια ως 17:00).',
    ]);
    capturePunch(db, alfa, LIXI, device, clock);
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
  });

  it('with no schedule: the ΛΗΞΗ check still works (at 21:00), and the page says the ΕΝΑΡΞΗ check is off', async () => {
    const { db, fake, device } = await setup();
    const alfa = await person(db, ALFA);
    const broken = new ErganiClient(fakeClientConfig(fake, { erganiPassword: new Secret('Wrong.pass1') }), { now });
    await ensureSchedule(db, broken, clock);
    expect(forgotAlarms(db, at('07:00'), 't', ONE)).toMatchObject([{ key: `schedule-unknown:0:${MONDAY}`, desk: { level: 'amber' }, push: undefined }]);
    expect(forgotAlarms(db, at('07:30'), 't', ONE)[0]?.push).toBeDefined();
    capturePunch(db, alfa, ENARXI, device, at('09:00'));
    expect(keys(forgotAlarms(db, at('20:59'), 't', ONE))).toEqual(['schedule-unknown']);
    expect(keys(forgotAlarms(db, at('21:00'), 't', ONE))).toEqual(['no-end', 'schedule-unknown']);
  });

  it('a page with STAMP_SCHEDULE=none never asks ΕΡΓΑΝΗ for a schedule — no read, no «Δεν διάβασα» line — and its ΛΗΞΗ check still works', async () => {
    // A branch with no declared schedule: EX_BASE_08 answers a bare null there (measured), so a reading page would
    // re-read every 15 minutes and show «Δεν διάβασα το ωράριο» every day from its first card.
    const { db, fake, device, outbox } = await setup();
    const alfa = await person(db, ALFA);
    const pushes: Push[] = [];
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(undefined), send: async (p) => void pushes.push(p), now, title: 't', log: () => undefined });
    const reads = () => fake.requests.filter((r) => r.route === 'WebServices/ExecuteService').length;
    clock = at('13:00');
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    for (const t of ['13:00', '13:20', '13:40', '18:00', '20:59']) {
      clock = at(t);
      await alarms.tick();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM schedule_reads').get()?.['n']).toBe(0);
    expect(alarms.deskWarnings(at('20:59'))).toEqual([]);
    clock = at('21:00');
    await alarms.tick();
    expect(keys(forgotAlarms(db, clock, 't', ONE))).toEqual(['no-end']);
    expect(pushes.some((p) => /ΛΗΞΗΣ/.test(p.message))).toBe(true);
    expect(pushes.some((p) => /ωράριο/.test(p.message))).toBe(false);
  });

  it('a page switched to STAMP_SCHEDULE=none holds no one to a schedule read already held for the day — failed or good', async () => {
    // `schedule_reads` is append-only, and a page that ran with `ergani` keeps today's reads after its restart with
    // `none`. Such a branch's reads all failed (EX_BASE_08 answers a bare null there): restarted on the morning of her
    // first card, it must not show or push «Δεν διάβασα το ωράριο» all that day.
    const { db, fake, client, device, outbox } = await setup([work(ALFA.afm), work(VITA.afm), work(STRANGER)]);
    const alfa = await person(db, ALFA);
    await person(db, VITA);
    const none = new Alarms({ db, branches: ONE, readers: readersOf(undefined), send: async () => undefined, now, title: 't', log: () => undefined });
    const broken = new ErganiClient(fakeClientConfig(fake, { erganiPassword: new Secret('Wrong.pass1') }), { now });
    await ensureSchedule(db, broken, clock);
    clock = at('09:00');
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:30');
    // The store as a reading page would see it (the control) — and the `none` page, which sees none of it.
    expect(keys(forgotAlarms(db, clock, 't', ONE))).toEqual(['schedule-unknown']);
    expect(none.deskWarnings(clock)).toEqual([]);
    await none.tick();
    // A GOOD read held for the day: Βήτα due at 09:00 and not in, a stranger in ΕΡΓΑΝΗ's schedule — on a `none` page, nothing.
    await ensureSchedule(db, client, clock);
    clock = at('09:40');
    expect(keys(forgotAlarms(db, clock, 't', ONE))).toEqual(['no-start', 'unknown-person']);
    expect(none.deskWarnings(clock)).toEqual([]);
    await none.tick();
    clock = at('21:00');
    await none.tick();
    expect(keys(none.deskWarnings(clock))).toEqual(['no-end']);
    expect(db.prepare('SELECT key FROM pushes').all().map((r) => String(r['key']).split(':')[0])).toEqual(['no-end']);
  });

  it('a ΛΗΞΗ with no ΕΝΑΡΞΗ that day', async () => {
    const { db, client, device } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    capturePunch(db, alfa, LIXI, device, at('17:01'));
    clock = at('17:02');
    expect(forgotAlarms(db, clock, 't', ONE).map((l) => l.desk?.text)).toContain(
      'Άλφα — χτύπησε ΛΗΞΗ (17:01) χωρίς ΕΝΑΡΞΗ σήμερα. Ενημερώστε τον λογιστή.',
    );
  });

  it('someone in ΕΡΓΑΝΗ\'s schedule who is not on the page — said without their ΑΦΜ; an exempt person is not a stranger', async () => {
    const { db, client } = await setup([work(ALFA.afm), work(STRANGER), work(VITA.afm)]);
    await person(db, ALFA);
    await addPerson(db, { ...VITA, exemptReason: 'οδοντίατρος' }, 'test', clock);
    await ensureSchedule(db, client, clock);
    const lines = forgotAlarms(db, at('08:00'), 't', ONE).filter((l) => l.key.startsWith('unknown-person'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.desk?.text).toContain('υπάρχει 1 άτομο');
    expect(JSON.stringify(lines)).not.toContain(STRANGER);
  });
});

describe('the owner\'s phone', () => {
  it('pushes each alarm once, naming the person, never an ΑΦΜ — and retries a failed push a minute later', async () => {
    const { db, client, alarms, pushes, fail } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:20');
    fail(true);
    await alarms.tick();
    expect(pushes).toEqual([]);
    clock += 30_000;
    fail(false);
    await alarms.tick();
    expect(pushes).toEqual([]);
    clock += 30_000;
    await alarms.tick();
    expect(pushes.map((p) => p.message)).toEqual(['Άλφα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 09:00).']);
    await alarms.tick();
    clock += 60 * 60_000;
    await alarms.tick();
    expect(pushes).toHaveLength(1);
    expect(JSON.stringify(pushes)).not.toMatch(/\d{9}/);
  });

  it('a push the server keeps refusing is never given up while its alarm holds — it arrives when the server is back', async () => {
    const { db, client, alarms, pushes, fail } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:20');
    fail(true);
    for (let minute = 0; minute < 12; minute++) {
      await alarms.tick();
      clock += 60_000;
    }
    expect(pushes).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM pushes WHERE outcome = 'failed'").get()?.['n']).toBe(10);
    fail(false);
    await alarms.tick(); // 09:32 — still inside the slower gap after the tenth failure (09:29)
    expect(pushes).toEqual([]);
    clock = at('09:39');
    await alarms.tick();
    expect(pushes.map((p) => p.message)).toEqual(['Άλφα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 09:00).']);
  });

  it('one schedule read at a time: passes during a read that hangs never start another one on the same login', async () => {
    const { db, client } = await setup();
    await person(db, ALFA);
    let calls = 0;
    const hung = () => {
      calls += 1;
      return new Promise<never>(() => undefined);
    };
    // The service list answers (the fake ΕΡΓΑΝΗ); the schedule itself never does.
    const reader = { listServices: () => client.listServices(), executeService: hung, now: () => clock, branchCode: '0' } as never;
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(reader), send: undefined, now, title: 't', log: () => undefined });
    clock = at('09:00');
    for (let pass = 0; pass < 3; pass += 1) {
      await alarms.tick();
      await new Promise((r) => setTimeout(r, 10));
      clock += 30_000; // the next pass, 30 s on, while ΕΡΓΑΝΗ still has not answered the first read
    }
    // A second read stacked on the first is a second ΕΡΓΑΝΗ call every 30 s on the login that files the cards (rule 8).
    expect(calls).toBe(1);
  });

  it('no pass waits on a schedule read that hangs: a card reaching its stop DURING the read is pushed on time', async () => {
    const { db, fake, device, outbox, pushes } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    const hung = () => new Promise<never>(() => undefined);
    const reader = { listServices: hung, executeService: hung, now: () => clock, branchCode: '0' } as never;
    const send = async (push: Push) => void pushes.push(push);
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(reader), send, now, title: 't', log: () => undefined });
    const within = (p: Promise<void>) => Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('held'), 200))]);
    clock = at('09:13') + 50_000; // the read starts here, and never answers
    expect(await within(alarms.tick())).toBe('done');
    clock = at('09:14') + 1_000; // the card reaches its 14-minute stop while the read is still hanging
    expect(await within(alarms.tick())).toBe('done');
    expect(pushes.at(-1)?.message).toMatch(/^Άλφα — η κάρτα ΕΝΑΡΞΗΣ \(09:00\) ΔΕΝ στάλθηκε, και δεν θα σταλεί πια αυτόματα — στις 09:15/);
  });

  it('stopping waits for the pass in flight, and that pass starts no schedule read against the store about to close', async () => {
    const { db, fake, device, outbox } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    let reads = 0;
    let answer: (() => void) | undefined;
    const read = () => {
      reads += 1;
      return new Promise<never>((_, reject) => (answer = () => reject(new Error('the read is over'))));
    };
    const reader = { listServices: read, executeService: read, now: () => clock, branchCode: '0' } as never;
    let release: (() => void) | undefined;
    const send = () => new Promise<void>((resolve) => (release = resolve));
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(reader), send, now, title: 't', log: () => undefined });
    const within = (p: Promise<void>) => Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('held'), 200))]);
    // main.ts closes the store the moment stop() resolves: a read the last pass started after it would land on a closed store.
    clock = at('09:06'); // the 5-minute push is on its way when the service is told to stop
    const pass = alarms.tick();
    await new Promise((r) => setTimeout(r, 20));
    const stopping = alarms.stop();
    expect(await within(stopping)).toBe('held'); // the pass is still sending
    release?.();
    await pass;
    expect(await within(stopping)).toBe('done');
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(0);
    // A read already running when stop() is called is waited for.
    const again = new Alarms({ db, branches: ONE, readers: readersOf(reader), send: undefined, now, title: 't', log: () => undefined });
    await again.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(1);
    const second = again.stop();
    expect(await within(second)).toBe('held');
    answer?.();
    expect(await within(second)).toBe('done');
  });

  it('«στάλθηκε τελικά» comes however long after the warning the card is settled — a Friday warning, a Monday settling', async () => {
    const { db, fake, device, outbox, alarms, pushes } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    const card = capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:06');
    await alarms.tick();
    expect(pushes.map((p) => p.message)).toEqual([expect.stringMatching(/δεν έχει φτάσει στην ΕΡΓΑΝΗ εδώ και 5 λεπτά/)]);
    clock = at('09:06') + 3 * 24 * 3_600_000; // three days later, the owner settles it
    decide(db, card.id, { kind: 'covered' }, { employeeId: undefined, label: 'ο εργοδότης', deviceId: undefined }, clock);
    await alarms.tick();
    expect(pushes.at(-1)?.message).toMatch(/καταγράφηκε ότι καλύφθηκε/);
    await alarms.tick();
    expect(pushes.filter((p) => p.message.includes('καλύφθηκε'))).toHaveLength(1);
  });

  it('the desk says when the owner\'s phone is not getting the alarms — until a push gets through again', async () => {
    const { db, client, alarms, fail } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:20');
    expect(alarms.deskWarnings(clock).map((w) => w.key)).not.toContain('push-failing');
    fail(true);
    await alarms.tick();
    expect(alarms.deskWarnings(clock)).toContainEqual({
      key: 'push-failing',
      level: 'amber',
      text: 'Οι ειδοποιήσεις στο κινητό του εργοδότη δεν περνούν αυτή τη στιγμή — ενημερώστε τον εργοδότη.',
    });
    fail(false);
    clock += 60_000;
    await alarms.tick();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).not.toContain('push-failing');
  });

  it('the desk line goes as soon as no alarm is owed — a failed push whose alarm then stopped holding leaves no line', async () => {
    const { db, client, device, outbox, alarms, fail } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:20'); // Άλφα has not stamped in: the «forgot» push fails (our ntfy down for a moment)
    fail(true);
    await alarms.tick();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).toContain('push-failing');
    fail(false);
    clock += 20_000; // ntfy is back; she stamps before the retry, and the card is filed
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).not.toContain('push-failing');
    clock = athensInstant('2026-10-06', '08:30'); // the next morning, with nothing pushed since
    expect(alarms.deskWarnings(clock).map((w) => w.key)).not.toContain('push-failing');
  });

  // ⓘ The amber line holds for EVERY kind of alarm that is owed a push, not only «forgot to stamp» — each kind below
  // is proven on its own, with no «forgot» alarm holding: she did stamp.
  it('the desk line holds for a CARD alarm whose push failed — the 14-minute stop the owner must act on', async () => {
    const { db, fake, device, outbox, alarms, fail } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:00') + LAST_SEND_MS;
    await outbox.pass();
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    fail(true);
    await alarms.tick();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).toContain('push-failing');
  });

  it('the desk line holds for a «στάλθηκε τελικά» whose push failed', async () => {
    const { db, fake, device, outbox, alarms, fail } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:06');
    await alarms.tick(); // «not through after 5 minutes» — pushed
    fake.failNextFilings(0, 503);
    clock += 60_000;
    await outbox.pass(); // filed after all: «στάλθηκε τελικά» is owed
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    fail(true);
    await alarms.tick();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).toContain('push-failing');
  });

  it('the desk line holds for a missing proof PDF whose push failed', async () => {
    const { db, device, outbox, alarms, fail } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    // Every scheduled proof fetch failed (as recorded by the outbox): the owner is owed the «proof missing» push.
    const attempt = Number(db.prepare("SELECT id FROM attempts WHERE outcome = 'filed'").get()?.['id']);
    for (let i = 0; i < EVIDENCE_DELAYS_MS.length; i++) {
      db.prepare("INSERT INTO evidence (attempt_id, at_ms, error) VALUES (?, ?, 'down')").run(attempt, clock + i);
    }
    expect(proofAlarms(db, clock, 't')).toHaveLength(1);
    expect(forgotAlarms(db, clock, 't', ONE)).toEqual([]);
    fail(true);
    await alarms.tick();
    expect(alarms.deskWarnings(clock).map((w) => w.key)).toContain('push-failing');
  });

  it('a card\'s alarm never waits on the schedule read — even when ΕΡΓΑΝΗ never answers it', async () => {
    const { db, fake, device, outbox, pushes } = await setup();
    const alfa = await person(db, ALFA);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:00') + LAST_SEND_MS;
    const hung = () => new Promise<never>(() => undefined);
    const reader = { listServices: hung, executeService: hung, now: () => clock, branchCode: '0' } as never;
    const send = async (push: Push) => void pushes.push(push);
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(reader), send, now, title: 't', log: () => undefined });
    void alarms.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushes.map((p) => p.message)).toEqual([expect.stringMatching(/^Άλφα — η κάρτα ΕΝΑΡΞΗΣ \(09:00\) ΔΕΝ στάλθηκε/)]);
  });

  it('a wall alarm that goes out after the 15 minutes says «late» — and an older card carries its day', async () => {
    const { db, client, fake, device, outbox, alarms, pushes } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = athensInstant('2026-10-06', '08:00'); // the service was down overnight: the first push goes out now
    await alarms.tick();
    const wall = pushes.find((p) => p.message.includes('ΔΕΝ στάλθηκε'));
    expect(wall?.message).toMatch(/^Άλφα — η κάρτα ΕΝΑΡΞΗΣ \(05\/10 09:00\) ΔΕΝ στάλθηκε μέσα στα 15 λεπτά — είναι εκπρόθεσμη\./);
    expect(wall?.message).not.toContain('προλαβαίνει');
  });

  it('a card that does not go through: refused, 5 minutes, the wall — then «στάλθηκε τελικά»', async () => {
    const { db, client, fake, device, alarms, outbox, pushes } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:00');
    fake.failNextFilings(1, 400, { message: `Το ΑΦΜ ${ALFA.afm} δεν αντιστοιχεί σε εργαζόμενο.` });
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    await alarms.tick();
    expect(pushes.at(-1)?.message).toBe(
      'Άλφα — η κάρτα ΕΝΑΡΞΗΣ (09:00) δεν έγινε δεκτή από την ΕΡΓΑΝΗ: «Το ΑΦΜ … δεν αντιστοιχεί σε εργαζόμενο.». ' +
        'Ξαναδοκιμάζω ως τις 09:14. Ανοίξτε τη σελίδα της υποδοχής.',
    );
    fake.failNextFilings(10_000, 503);
    clock = at('09:05');
    await outbox.pass();
    await alarms.tick();
    expect(pushes.at(-1)?.message).toMatch(/^Άλφα — η κάρτα ΕΝΑΡΞΗΣ \(09:00\) δεν έχει φτάσει στην ΕΡΓΑΝΗ εδώ και 5 λεπτά/);
    clock = at('09:00') + LAST_SEND_MS;
    await outbox.pass();
    await alarms.tick();
    // At the 14-minute stop the card is not late yet — and nobody is told to stamp again («One arrival, one card»): it
    // goes to the late-send list.
    expect(pushes.at(-1)).toMatchObject({
      priority: 5,
      message: expect.stringMatching(/ΔΕΝ στάλθηκε, και δεν θα σταλεί πια αυτόματα — στις 09:15 γίνεται εκπρόθεσμη\. .*αιτία, για εκπρόθεσμη αποστολή.*Επιθεώρηση Εργασίας/),
    });
    expect(JSON.stringify(pushes)).not.toContain('CardScanner');
    // The refusal's line still holds (it is read from the record for a day) — pushed once, by its key, all the same.
    expect(cardAlarms(db, clock, 't').map((l) => l.key)).toEqual([expect.stringMatching(/^queue:\d+:wall$/), expect.stringMatching(/^refused:\d+$/)]);
    expect(pushes.filter((p) => p.message.includes('δεν έγινε δεκτή'))).toHaveLength(1);
    expect(JSON.stringify(pushes)).not.toContain(ALFA.afm);
  });

  it('a refusal the next try heals before the alarms look is still told — then «στάλθηκε τελικά»', async () => {
    const { db, client, fake, device, alarms, outbox, pushes } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:00');
    fake.failNextFilings(1, 400, { message: 'Μη έγκυρη δήλωση (δοκιμή).' });
    const card = capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, card, clock).kind).toBe('filed');
    await alarms.tick();
    expect(pushes.map((p) => p.message)).toEqual([
      'Άλφα — η κάρτα ΕΝΑΡΞΗΣ (09:00) δεν έγινε δεκτή από την ΕΡΓΑΝΗ: «Μη έγκυρη δήλωση (δοκιμή).». Ανοίξτε τη σελίδα της υποδοχής.',
    ]);
    await alarms.tick();
    expect(pushes.at(-1)?.message).toMatch(/^Άλφα — η κάρτα ΕΝΑΡΞΗΣ \(09:00\) στάλθηκε τελικά στην ΕΡΓΑΝΗ/);
    await alarms.tick();
    expect(pushes).toHaveLength(2);
  });

  it('tells the owner when an alarmed card was filed after all', async () => {
    const { db, client, fake, device, alarms, outbox, pushes } = await setup();
    const alfa = await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    clock = at('09:00');
    fake.failNextFilings(10_000, 503);
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    clock = at('09:05');
    await outbox.pass();
    await alarms.tick();
    fake.failNextFilings(0, 503);
    clock = at('09:06');
    await outbox.pass();
    await alarms.tick();
    expect(pushes.at(-1)?.message).toBe('Άλφα — η κάρτα ΕΝΑΡΞΗΣ (09:00) στάλθηκε τελικά στην ΕΡΓΑΝΗ (09:06) ✓');
    const count = pushes.length;
    await alarms.tick();
    expect(pushes).toHaveLength(count);
  });

  it('tells the owner, once a day, when proof PDFs are still missing', async () => {
    const { db, client, device, pushes, instance } = await setup();
    const alfa = await person(db, ALFA);
    const outbox = outboxFor({
      db,
      instance,
      now,
      log: () => undefined,
      client: { submitWorkCard: (s) => client.submitWorkCard(s), fetchSubmissionPdf: () => Promise.reject(new Error('down')) },
    });
    const alarms = new Alarms({ db, branches: ONE, readers: readersOf(client), send: async (p) => void pushes.push(p), now, title: 't', log: () => undefined });
    clock = at('09:00');
    capturePunch(db, alfa, ENARXI, device, clock);
    await outbox.pass();
    expect(proofAlarms(db, clock, 't')).toEqual([]);
    for (const gap of EVIDENCE_DELAYS_MS) {
      clock += gap;
      await outbox.pass();
    }
    await alarms.tick();
    await alarms.tick();
    const proof = pushes.filter((p) => p.message.includes('αποδεικτικό PDF'));
    expect(proof).toHaveLength(1);
    expect(proof[0]?.message).toMatch(/^1 κάρτα στάλθηκε/);
  });

  it('sends JSON to our own server\'s root with the token; an error never carries the address or the token', async () => {
    const received: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    let status = 200;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = ntfySender(new Secret(`${base}/ergani-testclinic`), new Secret('tk_fabricated'));
    await send({ title: 'ΕΡΓΑΝΗ — Δοκιμή', message: `Άλφα — ${ALFA.afm}`, priority: 4 });
    expect(received).toEqual([
      { url: '/', auth: 'Bearer tk_fabricated', body: { topic: 'ergani-testclinic', title: 'ΕΡΓΑΝΗ — Δοκιμή', message: 'Άλφα — …', priority: 4 } },
    ]);
    status = 403;
    const refused = await send({ title: 't', message: 'm', priority: 3 }).catch((e: unknown) => e as Error);
    expect(String(refused)).toContain('HTTP 403');
    const dead = ntfySender(new Secret('http://127.0.0.1:9/ergani-x'), new Secret('tk_fabricated'));
    const unreachable = await dead({ title: 't', message: 'm', priority: 3 }).catch((e: unknown) => e as Error);
    expect(String(unreachable)).not.toMatch(/127\.0\.0\.1|tk_fabricated/);
  });

  it('refuses a push channel anyone could read: no token, ntfy.sh, or plain http', () => {
    const base = { STAMP_INSTANCE: 'testclinic', STAMP_DB: '/tmp/x.sqlite' };
    expect(() => loadStampSettings({ ...base, NTFY_URL: 'https://ntfy.example.invalid/topic' })).toThrow(/come together/);
    expect(() => loadStampSettings({ ...base, NTFY_URL: 'https://ntfy.sh/ergani-x', NTFY_TOKEN: 'tk' })).toThrow(/never ntfy\.sh/);
    // The same public server, spelt with DNS's trailing dot.
    expect(() => loadStampSettings({ ...base, NTFY_URL: 'https://ntfy.sh./ergani-x', NTFY_TOKEN: 'tk' })).toThrow(/never ntfy\.sh/);
    expect(() => loadStampSettings({ ...base, NTFY_URL: 'https://NTFY.SH../ergani-x', NTFY_TOKEN: 'tk' })).toThrow(/never ntfy\.sh/);
    expect(() => loadStampSettings({ ...base, NTFY_URL: 'http://ntfy.example.invalid/topic', NTFY_TOKEN: 'tk' })).toThrow(/https/);
    expect(loadStampSettings({ ...base, NTFY_URL: 'https://ntfy.example.invalid/ergani-x', NTFY_TOKEN: 'tk' }).ntfy).toBeDefined();
    // An inspectorate address left blank is «not known» (the page names the duty without one) — never a refusal to start.
    const branch0 = (env: NodeJS.ProcessEnv) => loadStampSettings({ ...base, ...env }).branches[0];
    expect(branch0({ STAMP_BRANCH_0_INSPECTORATE_EMAIL: '' })?.inspectorateEmail).toBeUndefined();
    expect(branch0({ STAMP_BRANCH_0_INSPECTORATE_EMAIL: '  ' })?.inspectorateEmail).toBeUndefined();
    expect(() => branch0({ STAMP_BRANCH_0_INSPECTORATE_EMAIL: 'not an address' })).toThrow(/email address/);
    // The schedule: read from ΕΡΓΑΝΗ unless a branch says `none` — nothing else is accepted.
    expect(branch0({})?.scheduleFromErgani).toBe(true);
    expect(branch0({ STAMP_BRANCH_0_SCHEDULE: 'ergani' })?.scheduleFromErgani).toBe(true);
    expect(branch0({ STAMP_BRANCH_0_SCHEDULE: 'none' })?.scheduleFromErgani).toBe(false);
    expect(() => branch0({ STAMP_BRANCH_0_SCHEDULE: 'off' })).toThrow(/ergani or none/);
    // With more than one branch, each names itself — the page says which branch it is.
    expect(() => loadStampSettings({ ...base, ERGANI_BRANCHES: '0,1', STAMP_BRANCH_0_LABEL: 'Κέντρο' })).toThrow(/STAMP_BRANCH_1_LABEL/);
    expect(withoutAfm(`ΑΦΜ ${AFM.alfa}, αρ. 12345678901`)).toBe('ΑΦΜ …, αρ. 12345678901');
  });
});

describe('the alarms never take the service down', () => {
  it('a pass that fails (the database gone, say) is logged and resolves — never an unhandled rejection', async () => {
    const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: '999999998' };
    const broken = initStampStore(':memory:', instance, ['0'], 'now');
    broken.close();
    const logged: string[] = [];
    const reader = { executeService: () => Promise.reject(new Error('unused')) } as never;
    const alarms = new Alarms({ db: broken, branches: ONE, readers: readersOf(reader), send: async () => undefined, now, title: 't', log: (l) => logged.push(l) });
    await expect(alarms.tick()).resolves.toBeUndefined();
    expect(logged.some((l) => l.startsWith('alarms: pass failed'))).toBe(true);
  });
});

describe('the alarms on the reception page', () => {
  it('shows the «forgot to stamp» alarms on the board, by name, without an ΑΦΜ', async () => {
    const { db, client, alarms, outbox } = await setup();
    await person(db, ALFA);
    await ensureSchedule(db, client, clock);
    const server = createStampServer({
      db,
      hooks: { outbox, warnings: (t) => alarms.deskWarnings(t) },
      instance: 'testclinic',
      branches: [{ code: '0', heading: 'Δοκιμή', inspectorateEmail: undefined }],
      cookieSecure: false,
      now,
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = createEnrollment(db, '0', 'Υποδοχή', clock);
    const cookie = (await fetch(`${base}/enroll/${token}`, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0] ?? '';
    clock = at('09:20');
    const text = await (await fetch(`${base}/api/board`, { headers: { cookie } })).text();
    expect(JSON.parse(text).warnings).toEqual([
      { key: `no-start:1:${MONDAY}:0:0`, level: 'red', text: 'Άλφα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 09:00).' },
    ]);
    expect(text).not.toContain(ALFA.afm);
  });
});

describe('the owner\'s `check` — READ ONLY, before the first real filing', () => {
  it('says whether WRKCardSE is offered, and who in ΕΡΓΑΝΗ\'s schedule is not on the list', async () => {
    const fake = await startErganiFake({ now, schedule: { '28/09/2026': [work(ALFA.afm), work(STRANGER)] } });
    cleanup.push(() => fake.close());
    const dir = mkdtempSync(join(tmpdir(), 'stamp-check-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = {
      STAMP_INSTANCE: 'testclinic',
      STAMP_DB: join(dir, 'stamp.sqlite'),
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: fake.baseUrl,
    };
    const lines: string[] = [];
    const io = { now, out: (l: string) => lines.push(l), client: () => new ErganiClient(fakeClientConfig(fake), { now }) };
    await adminCommand(['init'], env, io);
    await adminCommand(['add', '--afm', ALFA.afm, '--surname', ALFA.surname, '--first-name', ALFA.firstName], env, io);
    lines.length = 0;
    expect(await adminCommand(['check'], env, io)).toBe(0);
    expect(lines.join('\n')).toContain('✓ WRKCardSE is offered to this login.');
    expect(lines.join('\n')).toMatch(new RegExp(`${STRANGER}  ⛔ NOT ON THE LIST`));
    expect(fake.requests.some((r) => r.method === 'POST' && r.route === 'Documents/WRKCardSE')).toBe(false);

    // Every `check` reads afresh — a held read proves nothing about the login now — and fails when it cannot read.
    const reads = () => fake.requests.filter((r) => r.route === 'WebServices/ExecuteService').length;
    const before = reads();
    await adminCommand(['check'], env, io);
    expect(reads()).toBe(before + 1);
    const broken = { ...io, client: () => new ErganiClient(fakeClientConfig(fake, { erganiPassword: new Secret('Wrong.pass1') }), { now }) };
    await expect(adminCommand(['check'], env, broken)).rejects.toThrow();
    const unentitled = await startErganiFake({ now, entitlement: ['EX_BASE_01'] });
    cleanup.push(() => unentitled.close());
    lines.length = 0;
    const cannotRead = { ...io, client: () => new ErganiClient(fakeClientConfig(unentitled), { now }) };
    expect(await adminCommand(['check'], { ...env, ERGANI_BASE_URL: unentitled.baseUrl }, cannotRead)).toBe(1);
    expect(lines.join('\n')).toMatch(/could not be read/);

    // A branch that reads no schedule (SCHEDULE=none): `check` proves the login and the card form, and reads nothing.
    lines.length = 0;
    const readsBefore = reads();
    expect(await adminCommand(['check'], { ...env, STAMP_BRANCH_0_SCHEDULE: 'none' }, io)).toBe(0);
    expect(lines.join('\n')).toContain('✓ WRKCardSE is offered to this login.');
    expect(lines.join('\n')).toContain('not read for this branch (SCHEDULE=none)');
    expect(reads()).toBe(readsBefore);
    // …and fails when the card form is not offered to the login: on such a page that is all `check` proves.
    lines.length = 0;
    const noCard = { ...io, client: () => ({ listSubmissions: async () => [] }) as never };
    expect(await adminCommand(['check'], { ...env, STAMP_BRANCH_0_SCHEDULE: 'none' }, noCard)).toBe(1);
    expect(lines.join('\n')).toContain('⛔ WRKCardSE is NOT offered to this login');
  });
});

describe('an employer with two branches', () => {
  it('reads each branch\'s schedule with its own login, names the branch, and counts a card at either branch', async () => {
    const annexRow = (afm: string): FakeScheduleRow => ({ ...work(afm, '10:00:00', '14:00:00'), aa: '1' });
    const fake = await startErganiFake({
      now,
      branchLogins: { '0': branchLogin('0'), '1': branchLogin('1') },
      scheduleByBranch: { '0': { '28/09/2026': [work(ALFA.afm)] }, '1': { '28/09/2026': [annexRow(VITA.afm)] } },
    });
    cleanup.push(() => fake.close());
    const db = initStampStore(':memory:', { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm }, ['0', '1'], 'now');
    cleanup.push(() => db.close());
    const seat = deviceAt(db, '0');
    const annex = deviceAt(db, '1', 'Παράρτημα');
    const alfa = await person(db, ALFA);
    const vita = await person(db, VITA, '1397');
    // Both branches went live on an earlier day (their first cards).
    clock = athensInstant('2026-09-30', '09:00');
    capturePunch(db, alfa, ENARXI, seat, clock);
    capturePunch(db, vita, ENARXI, annex, clock + 1);
    const branches = [
      { code: '0', label: 'Κέντρο', fromSchedule: true },
      { code: '1', label: 'Λιμάνι', fromSchedule: true },
    ];
    clock = at('07:00');
    for (const code of ['0', '1']) await ensureSchedule(db, new ErganiClient(fakeBranchConfig(fake, code), { now }), clock);
    // Each read went out with its own branch's login — the fake refuses any other.
    expect(db.prepare('SELECT branch, error FROM schedule_reads ORDER BY id').all()).toEqual([
      { branch: '0', error: null },
      { branch: '1', error: null },
    ]);
    // Άλφα is due at the seat from 09:00 and stamps at the annex: a card at either branch is her ΕΝΑΡΞΗ.
    capturePunch(db, alfa, ENARXI, annex, at('09:05'));
    clock = at('10:20');
    const lines = forgotAlarms(db, clock, 't', branches);
    expect(lines.map((l) => l.key)).toEqual([`no-start:2:${MONDAY}:1:0`]);
    expect(lines[0]?.desk?.text).toBe('Βήτα — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από 10:00, Λιμάνι).');
  });

  it('a branch with no card yet on its page raises nothing from its schedule — it is not live there', async () => {
    const fake = await startErganiFake({
      now,
      branchLogins: { '0': branchLogin('0'), '1': branchLogin('1') },
      scheduleByBranch: { '0': { '28/09/2026': [work(ALFA.afm)] }, '1': { '28/09/2026': [{ ...work(VITA.afm), aa: '1' }] } },
    });
    cleanup.push(() => fake.close());
    const db = initStampStore(':memory:', { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm }, ['0', '1'], 'now');
    cleanup.push(() => db.close());
    const seat = deviceAt(db, '0');
    const alfa = await person(db, ALFA);
    await person(db, VITA, '1397');
    clock = athensInstant('2026-09-30', '09:00');
    capturePunch(db, alfa, ENARXI, seat, clock);
    clock = at('07:00');
    for (const code of ['0', '1']) await ensureSchedule(db, new ErganiClient(fakeBranchConfig(fake, code), { now }), clock);
    const branches = [
      { code: '0', label: 'Κέντρο', fromSchedule: true },
      { code: '1', label: 'Λιμάνι', fromSchedule: true },
    ];
    expect(forgotAlarms(db, at('09:30'), 't', branches).map((l) => l.key)).toEqual([`no-start:1:${MONDAY}:0:0`]);
  });
});
