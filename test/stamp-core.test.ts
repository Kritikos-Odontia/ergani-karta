// SPDX-License-Identifier: EUPL-1.2
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient, pdfOfBase64Answer, yyyymmddOfSubmitDate } from '../src/ergani/client.js';
import { ENARXI, LIXI } from '../src/ergani/types.js';
import { athensInstant, cardDateTime } from '../src/stamp/athens.js';
import { capturePunch, currentCardOf, suggestedType } from '../src/stamp/capture.js';
import { createEnrollment } from '../src/stamp/devices.js';
import { DeadlineReachedError, deadlineTransport, filingClient, withDeadline } from '../src/stamp/deadline.js';
import {
  EVIDENCE_DAILY_MS,
  EVIDENCE_DELAYS_MS,
  LAST_SEND_MS,
  OVERDUE_MS,
  Outbox,
  cardsMissingProof,
  attemptsOf,
  decide,
  punchById,
  stateOfPunch,
  submissionFor,
} from '../src/stamp/outbox.js';
import { addPerson, checkPin, chooseOwnPin, exemptPerson, setActive, stampingStaff, unlockPerson, VerifiedPerson } from '../src/stamp/staff.js';
import { BranchMismatchError, initStampStore, openStampStore, InstanceMismatchError, type Instance, type StampStore } from '../src/stamp/store.js';
import { branchLogin, fakeBranchConfig, fakeClientConfig, startErganiFake, type ErganiFake, type ErganiFakeOptions } from './fake/ergani-fake.js';
import { AFM, ALFA, VITA } from './fixtures/people.js';
import { addPersonForTest, deviceAt, outboxFor } from './fixtures/staff.js';

/**
 * OUR OWN STAMPING — the store, the PINs, the card writer and the outbox, against the ministry-derived fake.
 * ⛔ Every ΑΦΜ and name here is FABRICATED (test/fixtures/people.ts says how).
 * ⛔ No test reaches ΕΡΓΑΝΗ: the fence (test/setup.ts) blocks all three hosts; everything files to the local fake.
 */

const MONDAY_0900 = athensInstant('2026-10-05', '09:00');
const PEOPLE = [ALFA, VITA];

let clock = MONDAY_0900;
const now = () => clock;
let fakes: ErganiFake[] = [];
let stores: StampStore[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  for (const db of stores) if (db.isOpen) db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  fakes = [];
  stores = [];
  dirs = [];
  clock = MONDAY_0900;
});

async function setup(options: ErganiFakeOptions = {}, transportTimeoutMs?: number) {
  const fake = await startErganiFake({ now, ...options });
  fakes.push(fake);
  const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
  const db = initStampStore(':memory:', instance, ['0'], new Date(clock).toISOString());
  stores.push(db);
  const client = new ErganiClient(fakeClientConfig(fake), {
    now,
    transport: deadlineTransport(globalThis.fetch, now, transportTimeoutMs),
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const outbox = outboxFor({ db, client, instance, now, log: () => undefined });
  const device = deviceAt(db);
  return { fake, db, client, outbox, instance, device };
}

/** Add a person, choose their own PIN, and return them verified — the screen's path, without the screen. */
async function verified(db: StampStore, index = 0): Promise<VerifiedPerson> {
  const person = PEOPLE[index]!;
  const { id, oneTimePin } = await addPersonForTest(db, person, 'test', clock);
  const first = await checkPin(db, id, oneTimePin!, clock);
  if (first.kind !== 'ok') throw new Error('one-time PIN refused');
  const chosen = await chooseOwnPin(db, first.person, index === 0 ? '2580' : '1397', clock);
  if (!chosen.ok) throw new Error(chosen.problem);
  return chosen.person;
}

const filings = (fake: ErganiFake) => fake.requests.filter((r) => r.method === 'POST' && r.route === 'Documents/WRKCardSE');

describe('the store — the system of record (rule 2)', () => {
  it('refuses to delete or change a card, an attempt or a decision, and to delete a person or change an ΑΦΜ', async () => {
    const { db, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass();
    for (const sql of [
      'DELETE FROM punches',
      "UPDATE punches SET f_type = '1'",
      'DELETE FROM attempts',
      "UPDATE attempts SET outcome = 'failed'",
      'DELETE FROM employees',
      `UPDATE employees SET afm = '${AFM.gamma}'`,
      'DELETE FROM employee_events',
      'DELETE FROM instance',
    ]) {
      expect(() => db.exec(sql), sql).toThrow();
    }
    expect(() => db.prepare('INSERT OR REPLACE INTO punches SELECT * FROM punches WHERE id = ?').run(punch.id)).toThrow();
    expect(punchById(db, punch.id)?.fType).toBe(ENARXI);
  });

  it('every table of the record refuses DELETE and UPDATE — by its own trigger, not by a constraint (rule 2)', async () => {
    const { db, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass();
    clock += EVIDENCE_DELAYS_MS[0]!;
    await outbox.pass();
    db.prepare("INSERT INTO decisions (punch_id, kind, by_label, at_ms) VALUES (?, 'covered', 'test', ?)").run(punch.id, clock);
    db.prepare("INSERT INTO schedule_reads (branch, for_day, source_day, at_ms, rows) VALUES ('0', '2026-10-05', '2026-09-28', ?, '[]')").run(clock);
    db.prepare("INSERT INTO quiet_days (day, quiet, reason, by, at) VALUES ('2026-10-28', 1, 'test', 'test', 'now')").run();
    db.prepare("INSERT INTO pushes (key, at_ms, outcome) VALUES ('test', ?, 'sent')").run(clock);
    createEnrollment(db, '0', 'Δεύτερη', clock);
    for (const table of ['punches', 'dispatches', 'attempts', 'decisions', 'evidence', 'employee_events', 'schedule_reads', 'quiet_days', 'pushes']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n'], table).toBeGreaterThan(0);
    }
    // ⚠ Each UPDATE changes a column no CHECK reads, and each refusal is matched by the TRIGGER's own words — so it is
    // the trigger that is proven, never a constraint or a foreign key that happened to refuse first.
    for (const [sql, refusal] of [
      ['DELETE FROM punches', /append-only: punches/],
      ["UPDATE punches SET created_at = 'x'", /append-only: punches/],
      ['DELETE FROM dispatches', /append-only: dispatches/],
      ['UPDATE dispatches SET at_ms = at_ms + 1', /append-only: dispatches/],
      ['DELETE FROM attempts', /append-only: attempts/],
      ["UPDATE attempts SET message = 'x'", /append-only: attempts/],
      ['DELETE FROM decisions', /append-only: decisions/],
      ["UPDATE decisions SET by_label = 'x'", /append-only: decisions/],
      ['DELETE FROM evidence', /append-only: evidence/],
      ['UPDATE evidence SET at_ms = at_ms + 1', /append-only: evidence/],
      ['DELETE FROM employee_events', /append-only: employee_events/],
      ["UPDATE employee_events SET detail = 'x'", /append-only: employee_events/],
      ['DELETE FROM schedule_reads', /append-only: schedule_reads/],
      ['UPDATE schedule_reads SET at_ms = at_ms + 1', /append-only: schedule_reads/],
      ['DELETE FROM quiet_days', /append-only: quiet_days/],
      ["UPDATE quiet_days SET reason = 'x'", /append-only: quiet_days/],
      ['DELETE FROM pushes', /append-only: pushes/],
      ['UPDATE pushes SET at_ms = at_ms + 1', /append-only: pushes/],
      ['DELETE FROM instance', /never deleted/],
      ["UPDATE instance SET created_at = 'x'", /never changed/],
      ['DELETE FROM branches', /never removed/],
      ["UPDATE branches SET added_at = 'x'", /never changed/],
      ['DELETE FROM employees', /staff are never deleted/],
      [`UPDATE employees SET afm = '${AFM.gamma}'`, /ΑΦΜ is never changed/],
      ['DELETE FROM devices', /devices are never deleted/],
      ["UPDATE devices SET label = 'x'", /only be revoked/],
      ["UPDATE devices SET branch = branch || '1'", /only be revoked/],
      ['DELETE FROM enrollments', /never deleted/],
      ["UPDATE enrollments SET label = 'x'", /only be used/],
    ] as const) {
      expect(() => db.exec(sql), sql).toThrow(refusal);
    }
    // What MAY change, once: a device is revoked, and stays revoked.
    db.prepare("UPDATE devices SET revoked_at = 'x' WHERE id = ?").run(device.id);
    expect(() => db.prepare("UPDATE devices SET revoked_at = 'y' WHERE id = ?").run(device.id)).toThrow(/only be revoked, once/);
  });

  it('opens only for the employer, realm and branches it was made for — and never creates a store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    dirs.push(dir);
    const path = join(dir, 'stamp.sqlite');
    const mine: Instance = { name: 'testclinic', realm: 'local', employerAfm: AFM.employer };
    expect(() => openStampStore(path, mine, ['0'])).toThrow(/no stamping store/);
    initStampStore(path, mine, ['0'], 'now').close();
    expect(() => initStampStore(path, mine, ['0'], 'now')).toThrow(/already exists/);
    openStampStore(path, mine, ['0']).close();
    expect(() => openStampStore(path, { ...mine, employerAfm: AFM.otherEmployer }, ['0'])).toThrow(InstanceMismatchError);
    expect(() => openStampStore(path, { ...mine, realm: 'production' }, ['0'])).toThrow(InstanceMismatchError);
    expect(() => openStampStore(path, { ...mine, name: 'other' }, ['0'])).toThrow(InstanceMismatchError);
    // The branches: the configuration's list must be exactly the store's — a branch the store does not hold is added on
    // purpose (`add-branch`), and a branch it holds can never be left without a login.
    expect(() => openStampStore(path, mine, ['0', '1'])).toThrow(BranchMismatchError);
    expect(() => openStampStore(path, mine, ['1'])).toThrow(/has no login/);
  });
});

describe('the people and their PINs', () => {
  it('stamps by default; an exemption needs a reason and takes the button away (rule 6)', async () => {
    const { db } = await setup();
    const a = await addPerson(db, PEOPLE[0]!, 'test', clock);
    expect(a.oneTimePin).toMatch(/^\d{4}$/);
    expect(stampingStaff(db).map((p) => p.id)).toEqual([a.id]);
    await expect(addPerson(db, { ...PEOPLE[1]!, exemptReason: '  ' }, 'test', clock)).rejects.toThrow(/reason/);
    const b = await addPerson(db, { ...PEOPLE[1]!, exemptReason: 'οδοντίατρος' }, 'test', clock);
    expect(b.oneTimePin).toBeUndefined();
    expect(stampingStaff(db).map((p) => p.id)).toEqual([a.id]);
    await exemptPerson(db, PEOPLE[0]!.afm, 'οδοντίατρος', 'test', clock);
    expect(stampingStaff(db)).toEqual([]);
    const events = db.prepare("SELECT kind, detail FROM employee_events WHERE kind = 'exempted'").all();
    expect(events.map((e) => e['detail'])).toEqual(['οδοντίατρος', 'οδοντίατρος']);
  });

  it('refuses an ΑΦΜ that fails the check digit, and keeps names as the register spells them', async () => {
    const { db } = await setup();
    await expect(addPerson(db, { ...PEOPLE[0]!, afm: `${AFM.alfa.slice(0, 8)}9` }, 'test', clock)).rejects.toThrow(/ΑΦΜ/);
    const { id } = await addPerson(db, PEOPLE[0]!, 'test', clock);
    const row = db.prepare('SELECT surname, first_name, display_name FROM employees WHERE id = ?').get(id);
    expect(row).toEqual({ surname: 'ΠΑΡΑΔΕΙΓΜΑ', first_name: 'ΑΛΦΑ', display_name: 'Άλφα' });
  });

  it('makes the person choose their own PIN; the one the owner handed over stops working', async () => {
    const { db } = await setup();
    const { id, oneTimePin } = await addPersonForTest(db, PEOPLE[0]!, 'test', clock);
    const first = await checkPin(db, id, oneTimePin!, clock);
    expect(first).toMatchObject({ kind: 'ok', mustChooseOwn: true });
    if (first.kind !== 'ok') return;
    for (const weak of ['1111', '1234', '9876', '12a4']) {
      expect(await chooseOwnPin(db, first.person, weak, clock)).toMatchObject({ ok: false });
    }
    expect(await chooseOwnPin(db, first.person, oneTimePin!, clock)).toMatchObject({ ok: false });
    expect(await chooseOwnPin(db, first.person, '2580', clock)).toMatchObject({ ok: true });
    expect(await checkPin(db, id, oneTimePin!, clock)).toMatchObject({ kind: 'wrong' });
    expect(await checkPin(db, id, '2580', clock)).toMatchObject({ kind: 'ok', mustChooseOwn: false });
    const stored = String(db.prepare('SELECT pin_hash FROM employees WHERE id = ?').get(id)?.['pin_hash']);
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('2580');
  });

  it('counts PINs sent all at once one by one — a burst cannot walk past the lock', async () => {
    const { db } = await setup();
    const who = await verified(db);
    // Eleven wrong guesses and the right one, all at once: past the fifth try nothing is even compared.
    const guesses = [...Array.from({ length: 11 }, (_, i) => String(1000 + i * 7)), '2580'];
    const burst = await Promise.all(guesses.map((pin) => checkPin(db, who.employeeId, pin, clock)));
    expect(burst.map((r) => r.kind)).not.toContain('ok');
    expect(burst.filter((r) => r.kind === 'wrong').length).toBeLessThanOrEqual(4);
    expect(await checkPin(db, who.employeeId, '2580', clock)).toMatchObject({ kind: 'locked' });
  });

  it('locks a name for ten minutes after five wrong PINs — even the right PIN is refused until then', async () => {
    const { db } = await setup();
    const who = await verified(db);
    for (let i = 0; i < 4; i++) expect(await checkPin(db, who.employeeId, '0000', clock)).toMatchObject({ kind: 'wrong' });
    expect(await checkPin(db, who.employeeId, '0000', clock)).toMatchObject({ kind: 'locked' });
    expect(await checkPin(db, who.employeeId, '2580', clock)).toMatchObject({ kind: 'locked' });
    clock += 10 * 60_000;
    expect(await checkPin(db, who.employeeId, '2580', clock)).toMatchObject({ kind: 'ok' });
    for (let i = 0; i < 5; i++) await checkPin(db, who.employeeId, '0000', clock);
    unlockPerson(db, PEOPLE[0]!.afm, 'test', clock);
    expect(await checkPin(db, who.employeeId, '2580', clock)).toMatchObject({ kind: 'ok' });
  });
});

describe('the card writer (rule 1)', () => {
  it('takes only a person whose PIN was checked', () => {
    expect(() => new VerifiedPerson(Symbol('a PIN was checked') as never, 1, 'x')).toThrow(/checked PIN/);
  });

  it('refuses a card from someone deactivated or exempted since — even holding a PIN already checked (rules 1, 6)', async () => {
    const { db, device } = await setup();
    const leaving = await verified(db);
    const exempted = await verified(db, 1);
    setActive(db, PEOPLE[0]!.afm, false, 'test', clock);
    await exemptPerson(db, PEOPLE[1]!.afm, 'οδοντίατρος', 'test', clock);
    expect(await checkPin(db, leaving.employeeId, '2580', clock)).toEqual({ kind: 'not-here' });
    expect(await checkPin(db, exempted.employeeId, '1397', clock)).toEqual({ kind: 'not-here' });
    expect(() => capturePunch(db, leaving, ENARXI, device, clock)).toThrow(/not on the list/);
    expect(() => capturePunch(db, exempted, ENARXI, device, clock)).toThrow(/not on the list/);
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(0);
  });

  it('takes nothing merely SHAPED like a checked person — not in the type, not at run time', async () => {
    const { db, device } = await setup();
    const who = await verified(db);
    const shaped = { employeeId: who.employeeId, displayName: who.displayName };
    // @ts-expect-error — a plain object is not a VerifiedPerson: `npm run typecheck` fails if this line ever compiles.
    expect(() => capturePunch(db, shaped, ENARXI, device, clock)).toThrow(/checked PIN/);
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(0);
  });

  it('next morning, yesterday\'s forgotten evening ΛΗΞΗ never turns today\'s card into a ΛΗΞΗ of yesterday', async () => {
    const { db, device } = await setup();
    const who = await verified(db);
    capturePunch(db, who, ENARXI, device, athensInstant('2026-10-05', '09:00'));
    capturePunch(db, who, LIXI, device, athensInstant('2026-10-05', '13:00'));
    capturePunch(db, who, ENARXI, device, athensInstant('2026-10-05', '17:00'));
    // The 21:00 ΛΗΞΗ was forgotten. At 09:00 the next day the 17:00 ΕΝΑΡΞΗ is 16 hours old.
    const morning = athensInstant('2026-10-06', '09:00');
    expect(suggestedType(db, who.employeeId, morning)).toBe(ENARXI);
    expect(currentCardOf(db, who.employeeId, morning)).toBeUndefined();
    const card = capturePunch(db, who, LIXI, device, morning);
    expect(card.referenceDate).toBe('2026-10-06');
  });

  it('a shift that runs past midnight still closes on its own day — until 06:00', async () => {
    const { db, device } = await setup();
    const night = await verified(db);
    const late = await verified(db, 1);
    capturePunch(db, night, ENARXI, device, athensInstant('2026-10-05', '22:00'));
    capturePunch(db, late, ENARXI, device, athensInstant('2026-10-05', '22:00'));
    const small = athensInstant('2026-10-06', '05:59');
    expect(suggestedType(db, night.employeeId, small)).toBe(LIXI);
    expect(capturePunch(db, night, LIXI, device, small).referenceDate).toBe('2026-10-05');
    const six = athensInstant('2026-10-06', '06:00');
    expect(suggestedType(db, late.employeeId, six)).toBe(ENARXI);
    expect(capturePunch(db, late, LIXI, device, six).referenceDate).toBe('2026-10-06');
  });

  it('writes the server time with its Athens offset, summer and winter', async () => {
    const { db, device } = await setup();
    const who = await verified(db);
    expect(capturePunch(db, who, ENARXI, device, clock).fDate).toBe('2026-10-05T09:00:00+03:00');
    clock = athensInstant('2026-11-02', '09:00');
    expect(capturePunch(db, who, ENARXI, device, clock).fDate).toBe('2026-11-02T09:00:00+02:00');
    expect(cardDateTime(athensInstant('2026-10-25', '02:30'))).toMatch(/^2026-10-25T02:30:00\+0[23]:00$/);
  });

  it('files a ΛΗΞΗ after midnight against the working day of its ΕΝΑΡΞΗ', async () => {
    const { db, device } = await setup();
    const who = await verified(db);
    clock = athensInstant('2026-10-05', '18:00');
    capturePunch(db, who, ENARXI, device, clock);
    clock = athensInstant('2026-10-06', '00:30');
    const out = capturePunch(db, who, LIXI, device, clock);
    expect(out.referenceDate).toBe('2026-10-05');
    expect(out.fDate).toBe('2026-10-06T00:30:00+03:00');
    const next = capturePunch(db, who, ENARXI, device, athensInstant('2026-10-06', '09:00'));
    expect(next.referenceDate).toBe('2026-10-06');
  });
});

describe('the outbox — filing inside the 15 minutes', () => {
  it('files a card at once, as Card_v1.xsd wants it, and keeps the receipt', async () => {
    const { db, fake, outbox, device, instance } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass();
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]?.detail).toEqual({
      f_afm: AFM.alfa,
      f_eponymo: 'ΠΑΡΑΔΕΙΓΜΑ',
      f_onoma: 'ΑΛΦΑ',
      f_type: '0',
      f_reference_date: '2026-10-05',
      f_date: '2026-10-05T09:00:00+03:00',
      f_aitiologia: '',
    });
    const body = JSON.parse(filings(fake)[0]!.body);
    expect(body.Cards.Card[0]).toMatchObject({ f_afm_ergodoti: instance.employerAfm, f_aa: '0' });
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'filed', protocol: 'ΕΥΣ1', late: false });
    await outbox.pass();
    expect(fake.filed).toHaveLength(1);
  });

  it('keeps the card when ΕΡΓΑΝΗ is unreachable — it is written before any network call (rule 2)', async () => {
    const { db, device, instance } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    const down = outboxFor({
      db,
      instance,
      now,
      log: () => undefined,
      client: {
        submitWorkCard: () => Promise.reject(new TypeError('fetch failed')),
        fetchSubmissionPdf: () => Promise.reject(new Error('unused')),
      },
    });
    await down.pass();
    expect(punchById(db, punch.id)).toEqual(punch);
    expect(attemptsOf(db, punch.id)).toMatchObject([{ outcome: 'failed', message: expect.stringContaining('fetch failed') }]);
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'sending', attempts: 1 });
  });

  it('retries an outage at +10 s, +30 s, then every minute — and files when ΕΡΓΑΝΗ answers', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(3, 503);
    await outbox.pass();
    expect(filings(fake)).toHaveLength(1);
    clock += 9_000;
    await outbox.pass();
    expect(filings(fake)).toHaveLength(1);
    clock += 1_000;
    await outbox.pass();
    expect(filings(fake)).toHaveLength(2);
    clock += 30_000;
    await outbox.pass();
    expect(filings(fake)).toHaveLength(3);
    clock += 59_000;
    await outbox.pass();
    expect(filings(fake)).toHaveLength(3);
    clock += 1_000;
    await outbox.pass();
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'filed' });
    expect(attemptsOf(db, punch.id).map((a) => a.httpStatus)).toEqual([503, 503, 503, 200]);
  });

  it('keeps a refusal VERBATIM and shows it at once, and still asks inside the window (rule 8)', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    const sentence = 'Για το Παράρτημα: 0\\nΤο ΑΦΜ εργαζομένου δεν βρέθηκε.';
    fake.failNextFilings(1, 400, { message: sentence });
    await outbox.pass();
    const state = stateOfPunch(db, punch, clock);
    expect(state).toMatchObject({ kind: 'sending', lastProblem: { outcome: 'refused', httpStatus: 400, message: sentence } });
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'filed' });
  });

  it('raises the alarm at 5 minutes, stops at the wall, and hands the card to a human (rule 4)', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(10_000, 503);
    const start = clock;
    while (clock < start + 20 * 60_000) {
      await outbox.pass();
      const state = stateOfPunch(db, punch, clock);
      if (clock < start + LAST_SEND_MS) {
        expect(state.kind).toBe('sending');
        expect(state.kind === 'sending' && state.overdue).toBe(clock >= start + OVERDUE_MS);
      } else {
        expect(state).toMatchObject({ kind: 'needs-human', why: 'wall', canFileLate: true });
      }
      clock += 5_000;
    }
    const tries = attemptsOf(db, punch.id);
    // 0, +10 s, +40 s, +100 s, then every 60 s while before 14:00 — sixteen, the last at 13:40.
    expect(tries).toHaveLength(16);
    expect(Math.max(...tries.map((a) => a.startedMs)) - start).toBeLessThan(LAST_SEND_MS);
    expect(filings(fake)).toHaveLength(16);
  });

  it('sends nothing once the wall is reached, even mid-attempt — the guard is at the wire', async () => {
    const { db, fake, client, device, instance } = await setup();
    const who = await verified(db);
    await client.listSubmissions(); // signed in already
    const punch = capturePunch(db, who, ENARXI, device, clock);
    const card = submissionFor(punch, instance.employerAfm, '');
    const before = fake.requests.length;
    await expect(withDeadline(clock, () => client.submitWorkCard(card))).rejects.toBeInstanceOf(DeadlineReachedError);
    expect(fake.requests.length).toBe(before);

    // Begun at 13:50; ΕΡΓΑΝΗ answers 429 and the client waits 2 s, then 8 s — which crosses 14:00.
    clock = punch.eventMs + LAST_SEND_MS - 10_000;
    fake.throttleNext(5);
    await expect(withDeadline(punch.eventMs + LAST_SEND_MS, () => client.submitWorkCard(card))).rejects.toBeInstanceOf(
      DeadlineReachedError,
    );
    expect(fake.requests.length - before).toBe(2);
  });

  it('files late only on a human decision, with the reason the human chose', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(10_000, 503);
    await outbox.pass();
    const by = { employeeId: who.employeeId, label: who.displayName, deviceId: device.id };
    expect(() => decide(db, punch.id, { kind: 'file_late', fAitiologia: '003' }, by, clock)).toThrow(/does not need/);
    clock += 16 * 60_000;
    await outbox.pass();
    const before = filings(fake).length;
    await outbox.pass();
    expect(filings(fake).length).toBe(before);
    fake.failNextFilings(0, 503);
    decide(db, punch.id, { kind: 'file_late', fAitiologia: '003' }, by, clock);
    await outbox.pass();
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'filed', late: true });
    expect(fake.filed.at(-1)?.detail['f_aitiologia']).toBe('003');
    expect(db.prepare('SELECT by_label FROM decisions').get()?.['by_label']).toBe('Άλφα');
  });

  it('records «covered» (CardScanner, or the accountant) and sends nothing more', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(10_000, 503);
    clock += LAST_SEND_MS;
    decide(db, punch.id, { kind: 'covered' }, { employeeId: undefined, label: 'ο εργοδότης', deviceId: undefined }, clock);
    const before = filings(fake).length;
    clock += 60 * 60_000;
    await outbox.pass();
    expect(filings(fake).length).toBe(before);
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'covered', byLabel: 'ο εργοδότης' });
  });

  it('never sends an ΕΝΑΡΞΗ after a later card of the same day was filed — not even on a decision (rule 3)', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const start = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(1, 503);
    await outbox.pass();
    clock += 5_000;
    const end = capturePunch(db, who, LIXI, device, clock);
    await outbox.pass();
    expect(stateOfPunch(db, end, clock)).toMatchObject({ kind: 'filed' });
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked', canFileLate: false });
    const before = filings(fake).length;
    clock += 60_000;
    await outbox.pass();
    expect(filings(fake).length).toBe(before);
    const by = { employeeId: undefined, label: 'ο εργοδότης', deviceId: undefined };
    expect(() => decide(db, start.id, { kind: 'file_late', fAitiologia: '003' }, by, clock)).toThrow(/cannot be sent/);
    decide(db, start.id, { kind: 'covered' }, by, clock);
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'covered' });
  });

  it('holds the ΕΝΑΡΞΗ when a later card MAY have been filed — its answer lost — but not when ΕΡΓΑΝΗ refused it (rule 3)', async () => {
    const { db, fake, outbox, device } = await setup({}, 300);
    const who = await verified(db);
    const start = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(1, 503);
    await outbox.pass();
    clock += 5_000;
    const end = capturePunch(db, who, LIXI, device, clock);
    fake.delayFilings(600);
    await outbox.pass();
    // ΕΡΓΑΝΗ took the ΛΗΞΗ, but its answer never arrived: recorded as failed, and filed all the same.
    expect(attemptsOf(db, end.id)).toMatchObject([{ outcome: 'failed', message: expect.stringContaining('timeout') }]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.filed.map((f) => f.detail['f_type'])).toEqual(['1']);
    fake.delayFilings(0);
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked', canFileLate: false });
    expect(fake.filed.map((f) => f.detail['f_type'])).not.toContain('0');

    // A 400 is ΕΡΓΑΝΗ saying no: that later card did not get there, so the earlier ΕΝΑΡΞΗ still goes.
    const second = await setup();
    const other = await verified(second.db);
    const morning = capturePunch(second.db, other, ENARXI, second.device, clock);
    second.fake.failNextFilings(1, 503);
    await second.outbox.pass();
    clock += 5_000;
    capturePunch(second.db, other, LIXI, second.device, clock);
    second.fake.failNextFilings(1, 400, { message: 'Μη έγκυρη δήλωση (δοκιμή).' });
    await second.outbox.pass();
    clock += 10_000;
    await second.outbox.pass();
    expect(stateOfPunch(second.db, morning, clock)).toMatchObject({ kind: 'filed' });
  });

  it('when a ΛΗΞΗ and its own day\'s late ΕΝΑΡΞΗ are both due, the ΕΝΑΡΞΗ goes first — oldest first (rule 3)', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const start = capturePunch(db, who, ENARXI, device, clock);
    clock += LAST_SEND_MS + 60_000;
    decide(db, start.id, { kind: 'file_late', fAitiologia: '003' }, { employeeId: undefined, label: 'ο εργοδότης', deviceId: undefined }, clock);
    const end = capturePunch(db, who, LIXI, device, clock);
    await outbox.pass();
    expect(fake.filed.map((f) => f.detail['f_type'])).toEqual(['0', '1']);
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'filed', late: true });
    expect(stateOfPunch(db, end, clock)).toMatchObject({ kind: 'filed', late: false });
  });

  it('the outbox sends nothing past minute 14 — every request of an attempt, 429 waits included (rule 4)', async () => {
    const { db, fake, device, instance } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    const sent: number[] = [];
    const client = new ErganiClient(fakeClientConfig(fake), {
      now,
      transport: deadlineTransport((input, init) => {
        sent.push(now());
        return globalThis.fetch(input, init);
      }, now),
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const outbox = outboxFor({ db, client, instance, now, log: () => undefined });
    clock = punch.eventMs + LAST_SEND_MS - 10_000; // 13:50 — the first try starts here
    fake.throttleNext(10);
    await outbox.pass();
    expect(sent.length).toBeGreaterThan(0);
    for (const at of sent) expect(at).toBeLessThan(punch.eventMs + LAST_SEND_MS);
    expect(attemptsOf(db, punch.id)).toMatchObject([{ outcome: 'failed' }]);
  });

  it('a 200 whose receipt has a blank protocol number is not a filing — asked again, never taken as filed', async () => {
    const { db, fake, outbox, device } = await setup();
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(1, 200, [{ protocol: ' ', id: '1', submitDate: '05/10/2026 09:00' }]);
    await outbox.pass();
    expect(stateOfPunch(db, punch, clock).kind).toBe('sending');
    expect(attemptsOf(db, punch.id)).toMatchObject([{ outcome: 'failed', httpStatus: 200 }]);
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, punch, clock)).toMatchObject({ kind: 'filed', protocol: expect.stringMatching(/\S/) });
  });

  it('holds the ΕΝΑΡΞΗ after a restart when the service died in the middle of sending a later card (rule 3)', async () => {
    const { db, fake, outbox, device, instance } = await setup();
    const who = await verified(db);
    const start = capturePunch(db, who, ENARXI, device, clock);
    fake.failNextFilings(1, 503);
    await outbox.pass();
    clock += 5_000;
    const end = capturePunch(db, who, LIXI, device, clock);
    // The service that dies: its send of the ΛΗΞΗ leaves and never comes back — no attempt row is ever written.
    const dying = outboxFor({
      db,
      instance,
      now,
      log: () => undefined,
      client: { submitWorkCard: () => new Promise(() => undefined), fetchSubmissionPdf: () => new Promise(() => undefined) },
    });
    void dying.pass();
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.prepare('SELECT count(*) AS n FROM dispatches WHERE punch_id = ?').get(end.id)?.['n']).toBe(1);
    expect(attemptsOf(db, end.id)).toEqual([]);
    // The next service, after the restart.
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked' });
    expect(fake.filed.map((f) => f.detail['f_type'])).not.toContain('0');
  });

  it('the service files only through a client bound to the wall — and main.ts builds no other', async () => {
    const fake = await startErganiFake({ now });
    fakes.push(fake);
    const client = filingClient(fakeClientConfig(fake), now);
    await expect(withDeadline(clock - 1, () => client.listSubmissions())).rejects.toBeInstanceOf(DeadlineReachedError);
    expect(fake.requests).toHaveLength(0);
    await expect(withDeadline(clock + 60_000, () => client.listSubmissions())).resolves.toBeDefined();
    const main = readFileSync(fileURLToPath(new URL('../src/stamp/main.ts', import.meta.url)), 'utf8');
    expect(main).toContain('filingClient(config, now)');
    expect(main).not.toMatch(/new ErganiClient\(/);
  });

  it('main.ts hands the alarms each branch\'s reader unless that branch says SCHEDULE=none', () => {
    // The «not stamped in» alarm hangs on these lines (a missed card: €10,500 — docs/RULES.md rule 6), and a branch
    // with SCHEDULE=none has no reader, so the compiler no longer holds it. A source check, as above.
    const main = readFileSync(fileURLToPath(new URL('../src/stamp/main.ts', import.meta.url)), 'utf8');
    expect(main).toContain("const readsSchedule = (code: string) => stamp.branches.find((b) => b.code === code)?.scheduleFromErgani === true;");
    expect(main).toContain('readers: new Map([...clients].filter(([code]) => readsSchedule(code))),');
  });

  it('reports itself healthy only after a pass that completed', async () => {
    const { db, outbox } = await setup();
    await outbox.pass();
    const healthyAt = outbox.lastPassMs;
    expect(healthyAt).toBe(clock);
    db.close();
    clock += 60_000;
    await outbox.pass();
    expect(outbox.lastPassMs).toBe(healthyAt);
  });

  it('counts each recorded attempt as progress, so a slow pass through a slow ΕΡΓΑΝΗ is not read as stopped', async () => {
    const { db, device, instance } = await setup();
    const who = await verified(db);
    const seen: Array<number | undefined> = [];
    const slow = outboxFor({
      db,
      instance,
      now,
      log: () => undefined,
      client: {
        submitWorkCard: async () => {
          seen.push(slow.lastPassMs);
          clock += 40_000;
          throw new TypeError('fetch failed');
        },
        fetchSubmissionPdf: () => Promise.reject(new Error('unused')),
      },
    });
    const start = clock;
    for (let i = 0; i < 3; i++) capturePunch(db, who, i % 2 === 0 ? ENARXI : LIXI, device, start + i);
    await slow.pass();
    expect(seen).toEqual([undefined, start + 40_000, start + 80_000]);
  });

  it('picks up after a restart: a card captured before the service died is filed by the next one', async () => {
    const { fake } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    dirs.push(dir);
    const path = join(dir, 'stamp.sqlite');
    const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
    const first = initStampStore(path, instance, ['0'], 'now');
    const device = deviceAt(first);
    const who = await verified(first);
    const punch = capturePunch(first, who, ENARXI, device, clock);
    first.close();
    clock += 30_000;
    const db = openStampStore(path, instance, ['0']);
    stores.push(db);
    const client = new ErganiClient(fakeClientConfig(fake), { now });
    await outboxFor({ db, client, instance, now, log: () => undefined }).pass();
    expect(stateOfPunch(db, punchById(db, punch.id)!, clock)).toMatchObject({ kind: 'filed' });
  });

  it('a lost answer is simply asked again — two filings of one card are harmless (rule 3)', async () => {
    const { db, fake, outbox, device } = await setup({}, 300);
    const who = await verified(db);
    const punch = capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass(); // signs in and files; nothing delayed yet
    expect(stateOfPunch(db, punch, clock).kind).toBe('filed');
    const second = capturePunch(db, who, LIXI, device, clock + 1000);
    clock += 1000;
    fake.delayFilings(600);
    await outbox.pass();
    expect(attemptsOf(db, second.id)).toMatchObject([{ outcome: 'failed', message: expect.stringContaining('timeout') }]);
    fake.delayFilings(0);
    clock += 10_000;
    await outbox.pass();
    expect(stateOfPunch(db, second, clock).kind).toBe('filed');
    expect(fake.filed.filter((f) => f.detail['f_type'] === '1')).toHaveLength(2);
  });
});

describe('the proof PDF (guide §2.1.8)', () => {
  it.each(['object', 'json-string', 'bare'] as const)('is fetched after filing and kept with its hash (%s answer)', async (pdfShape) => {
    const { db, outbox, device } = await setup({ pdfShape });
    const who = await verified(db);
    capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass();
    clock += 5_000;
    await outbox.pass();
    const row = db.prepare('SELECT pdf, sha256, error FROM evidence').get();
    expect(row?.['error']).toBeNull();
    expect(Buffer.from(row?.['pdf'] as Uint8Array).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(String(row?.['sha256'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never abandons a missing proof: after the scheduled tries it asks daily, and the owner is told', async () => {
    const { db, client, device, instance } = await setup();
    const who = await verified(db);
    const outbox = outboxFor({
      db,
      instance,
      now,
      log: () => undefined,
      client: { submitWorkCard: (s) => client.submitWorkCard(s), fetchSubmissionPdf: () => Promise.reject(new Error('down')) },
    });
    const punch = capturePunch(db, who, ENARXI, device, clock);
    await outbox.pass();
    const tries = () => Number(db.prepare('SELECT count(*) AS n FROM evidence').get()?.['n']);
    for (const gap of EVIDENCE_DELAYS_MS) {
      expect(cardsMissingProof(db)).toEqual([]);
      clock += gap;
      await outbox.pass();
    }
    expect(tries()).toBe(EVIDENCE_DELAYS_MS.length);
    expect(cardsMissingProof(db)).toMatchObject([{ punchId: punch.id, protocol: 'ΕΥΣ1' }]);
    clock += EVIDENCE_DAILY_MS - 1;
    await outbox.pass();
    expect(tries()).toBe(EVIDENCE_DELAYS_MS.length);
    clock += 1;
    await outbox.pass();
    expect(tries()).toBe(EVIDENCE_DELAYS_MS.length + 1);
  });

  it('converts submitDate to yyyymmdd on ΕΡΓΑΝΗ\'s own calendar day, across a month boundary', () => {
    expect(yyyymmddOfSubmitDate('01/10/2026 00:10')).toBe('20261001');
    expect(yyyymmddOfSubmitDate('30/09/2026 23:59')).toBe('20260930');
    expect(() => yyyymmddOfSubmitDate('2026-10-01')).toThrow();
  });

  it('never keeps an answer that is not a PDF', () => {
    const pdf = Buffer.from('%PDF-1.4 x').toString('base64');
    expect(pdfOfBase64Answer(`"${pdf}"`).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfOfBase64Answer(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    expect(() => pdfOfBase64Answer(Buffer.from('<html>').toString('base64'))).toThrow(/PDF/);
    expect(() => pdfOfBase64Answer('{"message":"x"}')).toThrow();
    expect(() => pdfOfBase64Answer('')).toThrow();
  });
});

describe('structure — no path writes a card for someone else (rule 1)', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );

  it('only capture.ts inserts a card, and only the PIN-checked page calls it', () => {
    const writers = files(srcDir).filter((f) => /INSERT\s+INTO\s+punches/i.test(readFileSync(f, 'utf8')));
    expect(writers.map((f) => f.slice(srcDir.length))).toEqual(['stamp/capture.ts']);
    const callers = files(srcDir).filter((f) => !f.endsWith('capture.ts') && /\bcapturePunch\s*\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(srcDir.length))).toEqual(['stamp/server.ts']);
    expect(readFileSync(join(srcDir, 'stamp/admin.ts'), 'utf8')).not.toMatch(/capturePunch|INSERT\s+INTO\s+punches/);
  });
});
