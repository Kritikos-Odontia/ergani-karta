// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ownerPages } from '../src/desktop/owner/pages.js';
import { desktopPaths } from '../src/desktop/paths.js';
import { forgotAlarms, cardAlarms } from '../src/stamp/alarms.js';
import { orthodoxEaster } from '../src/stamp/holidays.js';
import { addDays, athensInstant } from '../src/stamp/athens.js';
import { capturePunch } from '../src/stamp/capture.js';
import { checkPin, chooseOwnPin } from '../src/stamp/staff.js';
import { initStampStore, type StampStore } from '../src/stamp/store.js';
import { ALFA, VITA, AFM } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach((f) => f()); cleanup = []; });
const branches = [{ code: '0', label: 'Έδρα', fromSchedule: true }, { code: '1', label: 'Δεύτερο', fromSchedule: true }];

async function setup(day = '2026-10-05') {
  const root = mkdtempSync(join(tmpdir(), 'ergani-calendar-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = desktopPaths(root);
  mkdirSync(dirname(paths.stampDb), { recursive: true });
  const env = { ERGANI_USERTYPE: '02', ERGANI_BASE_URL: 'http://127.0.0.1:1/api', ERGANI_EMPLOYER_AFM: AFM.employer,
    ERGANI_BRANCHES: '0,1', ERGANI_BRANCH_0_USERNAME: 'fixture00', ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
    ERGANI_BRANCH_1_USERNAME: 'fixture01', ERGANI_BRANCH_1_PASSWORD: 'Fixture.p2', STAMP_BRANCH_0_LABEL: 'Έδρα', STAMP_BRANCH_1_LABEL: 'Δεύτερο', STAMP_INSTANCE: 'testclinic', STAMP_DB: paths.stampDb };
  const db = initStampStore(paths.stampDb, { name: 'testclinic', realm: 'local', employerAfm: AFM.employer }, ['0', '1'], 'x');
  cleanup.push(() => db.close());
  const people = [];
  for (const [i, who] of [ALFA, VITA].entries()) {
    const added = await addPersonForTest(db, who, 'test', athensInstant(day, '07:00'));
    const checked = await checkPin(db, added.id, added.oneTimePin!, athensInstant(day, '07:00'));
    if (checked.kind !== 'ok') throw new Error('PIN');
    const own = await chooseOwnPin(db, checked.person, i === 0 ? '2580' : '1397', athensInstant(day, '07:00'));
    if (!own.ok) throw new Error(own.problem);
    people.push(own.person);
  }
  const devices = [deviceAt(db, '0'), deviceAt(db, '1')];
  for (const device of devices) capturePunch(db, people[0]!, '0', device, athensInstant(addDays(day, -7), '09:00'));
  for (const branch of ['0', '1']) {
    const rows = [ALFA, VITA].map((p) => ({ Afm: p.afm, Type: 'ΕΡΓ', HourFrom: '09:00', HourTo: '17:00' }));
    db.prepare('INSERT INTO schedule_reads (branch, for_day, source_day, at_ms, rows) VALUES (?, ?, ?, ?, ?)')
      .run(branch, day, '2026-09-28', athensInstant(day, '07:00'), JSON.stringify(rows));
  }
  const pages = ownerPages({ paths, env, now: () => athensInstant(day, '18:00'), log: () => undefined, erganiSilentSince: () => undefined, openFolders: false });
  const calendar = pages.get('/calendar');
  const post = async (values: Record<string, string>) => {
    expect(calendar, 'the owner can open the reminder calendar').toBeDefined();
    return calendar!({ method: 'POST', path: '/calendar', query: new URLSearchParams(), form: new URLSearchParams(values), csrf: 'test' });
  };
  return { db, day, people, devices, post, calendar };
}
const starts = (db: StampStore, day: string, time = '10:00') => forgotAlarms(db, athensInstant(day, time), 'Δοκιμή', branches).filter((l) => l.key.startsWith('no-start:'));

it('does not ask anybody to stamp on the built-in national holiday', async () => {
  const { db, day } = await setup('2026-10-28');
  expect(starts(db, day)).toEqual([]);
});

it('suppresses only the employee on leave, keeps filing alerts, and restores reminders by appending a withdrawal', async () => {
  const { db, day, people, devices, post } = await setup();
  await post({ do: 'leave', employee: String(people[0]!.employeeId), from: day, to: day, reason: 'Άδεια' });
  expect(starts(db, day).map((l) => l.key.split(':')[1])).toEqual([String(people[1]!.employeeId), String(people[1]!.employeeId)]);
  capturePunch(db, people[0]!, '0', devices[0]!, athensInstant(day, '08:00'));
  expect(cardAlarms(db, athensInstant(day, '10:00'), 'Δοκιμή').length).toBeGreaterThan(0);
  // Leave must not make a genuine open arrival disappear from the clock-out reminders.
  expect(forgotAlarms(db, athensInstant(day, '21:30'), 'Δοκιμή', branches).some((l) => l.key.startsWith(`no-end:${people[0]!.employeeId}:`))).toBe(true);
  await post({ do: 'reset', employee: String(people[0]!.employeeId), from: day, to: day, reason: 'Επιστροφή' });
  expect(db.prepare('SELECT count(*) AS n FROM reminder_calendar').get()?.['n']).toBe(2);
  expect(() => db.exec("UPDATE reminder_calendar SET reason = 'changed'")).toThrow(/append-only/);
  expect(() => db.exec('DELETE FROM reminder_calendar')).toThrow(/append-only/);
});

it('replaces stale hours for one employee and branch, including split shifts and a schedule-disabled branch', async () => {
  const { db, day, people, post } = await setup();
  await post({ do: 'hours', employee: String(people[0]!.employeeId), branch: '0', from: day, to: day, hours: '11:00-13:00,17:00-20:00', reason: 'Αλλαγή' });
  expect(starts(db, day).filter((l) => l.key.startsWith(`no-start:${people[0]!.employeeId}:`)).map((l) => l.key.split(':')[3])).toEqual(['1']);
  const disabled = [{ ...branches[0]!, fromSchedule: false }];
  expect(forgotAlarms(db, athensInstant(day, '11:21'), 'Δοκιμή', disabled).filter((l) => l.key.startsWith('no-start:'))).toHaveLength(1);
  const device = deviceAt(db);
  capturePunch(db, people[0]!, '0', device, athensInstant(day, '11:00'));
  expect(forgotAlarms(db, athensInstant(day, '13:31'), 'Δοκιμή', disabled).some((l) => l.key.startsWith('no-end:'))).toBe(true);
});

it('rejects impossible days, reversed ranges, unknown people, overlapping intervals and unknown branches without saving', async () => {
  const { db, day, people, post } = await setup();
  for (const invalid of [ { from: '2026-02-30' }, { to: '2026-10-04' }, { employee: '9999' }, { branch: '7' }, { hours: '09:00-13:00,12:00-17:00' }, { hours: '25:00-26:00' } ]) {
    const result = await post({ do: 'hours', employee: String(people[0]!.employeeId), branch: '0', from: day, to: day, hours: '09:00-17:00', reason: 'Δοκιμή', ...invalid });
    expect('body' in result && result.body).toContain('Δεν έγινε');
  }
  expect(db.prepare('SELECT count(*) AS n FROM reminder_calendar').get()?.['n']).toBe(0);
});

it('computes Orthodox Easter and quiets Easter Monday; the owner can mark a built-in holiday open', async () => {
  expect(orthodoxEaster(2024)).toBe('2024-05-05');
  expect(orthodoxEaster(2025)).toBe('2025-04-20');
  expect(orthodoxEaster(2026)).toBe('2026-04-12');
  expect(orthodoxEaster(2027)).toBe('2027-05-02');
  const { db, day, post } = await setup('2026-04-13');
  expect(starts(db, day)).toEqual([]);
  await post({ do: 'unquiet', from: day, to: day, reason: 'Ανοικτό — επιβεβαιώθηκε με τον λογιστή' });
  expect(starts(db, day)).toHaveLength(4);
});

it('new replacement hours can raise their own reminder after an earlier reminder was already sent', async () => {
  const { db, day, people, post } = await setup();
  const fields = { do: 'hours', employee: String(people[0]!.employeeId), branch: '0', from: day, to: day, reason: 'Αλλαγή' };
  await post({ ...fields, hours: '09:00-17:00' });
  const first = starts(db, day).find((l) => l.key.startsWith(`no-start:${people[0]!.employeeId}:${day}:0:`))!;
  db.prepare("INSERT INTO pushes (key, at_ms, outcome) VALUES (?, ?, 'sent')").run(first.key, athensInstant(day, '10:00'));
  await post({ ...fields, hours: '11:00-19:00' });
  expect(starts(db, day)).not.toContainEqual(first);
  const second = starts(db, day, '11:30').find((l) => l.key.startsWith(`no-start:${people[0]!.employeeId}:${day}:0:`))!;
  expect(second.key).not.toBe(first.key); // the push deduplicator must not swallow the new missed shift
});

it('reminds about the end of an owner-marked overnight shift after midnight, on its own working day', async () => {
  const { db, day, people, devices, post } = await setup();
  await post({ do: 'hours', employee: String(people[0]!.employeeId), branch: '0', from: day, to: day, hours: '22:00-02:00', reason: 'Νυχτερινή αλλαγή' });
  capturePunch(db, people[0]!, '0', devices[0]!, athensInstant(day, '22:00'));
  expect(forgotAlarms(db, athensInstant(day, '23:00'), 'Δοκιμή', [branches[0]!]).some((l) => l.key.startsWith('no-end:'))).toBe(false);
  const afterMidnight = forgotAlarms(db, athensInstant('2026-10-06', '02:31'), 'Δοκιμή', [branches[0]!]);
  expect(afterMidnight.some((l) => l.key.startsWith(`no-end:${people[0]!.employeeId}:${day}:0:`))).toBe(true);
});
