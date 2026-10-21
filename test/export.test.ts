// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiError } from '../src/ergani/client.js';
import type { ReadClient } from '../src/ergani/exbase.js';
import { exportCommand, runExport } from '../src/export/cli.js';
import { employeeRecord, employeesIn, monthComparison, standing, type ComparedDay } from '../src/export/model.js';
import { comparisonPage, employeeCsv, employeePage } from '../src/export/render.js';
import { pullMonth } from '../src/records/pull.js';
import { recordMigrations, openRecordStore, openRecordStoreForReading, type RecordStore } from '../src/records/store.js';
import type { ErganiRealm } from '../src/config.js';
import { MEASURED_NOW } from './fake/ergani-fake.js';

/**
 * R3 — the per-employee export and the month-late comparison, read from R2's record store.
 * The store is filled by R2's own pull, driven by a scripted read client; `src/export/` itself never
 * sees a client. ⛔ Every ΑΦΜ is a ministry example value. No test reaches ΕΡΓΑΝΗ.
 */

const A = '000000000';
const B = '999999999';
const C = '012345678';
/** The employer: a nine-digit string that fails the check digit, so no real one. */
const EMPLOYER = '000000001';
/** 25/09/2026 12:00 in Athens: 25 days after the newest day the store holds (31/08). */
const GENERATED = Date.parse('2026-09-25T12:00:00+03:00');
const REPO = fileURLToPath(new URL('../', import.meta.url));

type Rows = Record<string, object[]>;
const wire = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const stamp = (afm: string, day: string, from: string, to: string, nextDay = false) => ({
  Afm: afm,
  Date: wire(day),
  HourFrom: from,
  HourTo: to,
  IsEndDateDifferentThanDate: nextDay ? '1' : '0',
});
/**
 * A declared row in the shape measured 2026-09-28 (src/ergani/types.ts `ScheduleRow`): no hour fields on a day
 * off, `Extra: null` except on leave, where it is absent. `scripted` adds the `aa` and `Date` every
 * real row carries.
 */
const declared = (afm: string, type: string, from: string, to: string) => ({
  Afm: afm,
  Type: type,
  ...(from === '' && to === '' ? {} : { HourFrom: from, HourTo: to }),
  BreakMinutes: '15',
  BreakInWork: '0',
  ...(type === 'ΑΔΠΠΜ' ? {} : { Extra: null }),
});

/**
 * A read client answering from a script, keyed by `YYYY-MM-DD`. `special` may return an Error (thrown)
 * or a whole answer; anything unscripted answers a recognisable empty day.
 */
function scripted(
  stamps: Rows,
  schedule: Rows,
  special: (code: string, day: string) => unknown = () => undefined,
  branch = '0',
): ReadClient {
  const declaredParams = [
    { name: 'Dt', description: '', isRequired: true, type: 'Date', maxLength: 0 },
    { name: 'PararthmaAa', description: '', isRequired: true, type: 'Int', maxLength: 0 },
  ];
  return {
    listServices: async () => [
      { name: 'EX_BASE_07', description: '', parameters: declaredParams },
      { name: 'EX_BASE_08', description: '', parameters: declaredParams },
    ],
    executeService: async (code, params) => {
      const date = (params as { Parameters: Array<{ ParameterValue: string }> }).Parameters[0]?.ParameterValue ?? '';
      const day = `${date.slice(6, 10)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
      const answer = special(code, day);
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      const rows = code === 'EX_BASE_07' ? stamps[day] : schedule[day]?.map((r) => ({ aa: branch, Date: date, ...r }));
      return { [code]: rows === undefined ? {} : { Rows: rows } };
    },
    now: () => MEASURED_NOW,
    branchCode: branch,
  };
}

const AUGUST_STAMPS: Rows = {
  '2026-08-03': [stamp(A, '2026-08-03', '08:00', '16:00'), stamp(C, '2026-08-03', '07:00', '15:00')],
  '2026-08-04': [stamp(A, '2026-08-04', '08:05', '17:30')],
  '2026-08-06': [stamp(A, '2026-08-06', '09:00', '13:00')],
  '2026-08-07': [stamp(A, '2026-08-07', '08:00', '21:00')],
  // An hour in a form nobody has measured — and characters a page and a CSV must both survive.
  '2026-08-10': [stamp(A, '2026-08-10', '<08:00>;', '16:00"')],
  '2026-08-28': [stamp(A, '2026-08-28', '17:00', '00:30', true)],
};
const AUGUST_SCHEDULE: Rows = {
  '2026-08-03': [declared(A, 'ΕΡΓ', '08:00', '16:00'), declared(B, 'ΑΔΠΠΜ', '', ''), declared(C, 'ΕΡΓ', '07:00', '15:00')],
  '2026-08-04': [declared(A, 'ΕΡΓ', '08:00', '16:00')],
  '2026-08-05': [declared(A, 'ΕΡΓ', '08:00', '16:00')],
  '2026-08-06': [declared(A, 'ΑΝ', '', '')],
  // σπαστό ωράριο declared; one long stamp.
  '2026-08-07': [declared(A, 'ΕΡΓ', '08:00', '12:00'), declared(A, 'ΕΡΓ', '17:00', '21:00')],
  '2026-08-10': [declared(A, 'ΕΡΓ', '08:00', '16:00')],
  '2026-08-28': [declared(A, 'ΕΡΓ', '17:00', '00:30')],
};

/**
 * The record as the tests read it:
 *   · August, pulled twice. Between the pulls the 4th's stamp was corrected upstream (17:30 → 16:10)
 *     and the 5th re-declared as a rest day — both earlier versions stay in the record.
 *   · July, pulled once: the 20th's schedule answer was not recognised, and the walk STOPPED at the
 *     25th's stamps, so 25–31/07 were never read.
 */
async function fill(db: RecordStore, realm: ErganiRealm = 'local'): Promise<void> {
  await pullMonth(db, scripted(AUGUST_STAMPS, AUGUST_SCHEDULE), { realm, employerAfm: EMPLOYER, month: '2026-08' });
  await pullMonth(
    db,
    scripted(
      { ...AUGUST_STAMPS, '2026-08-04': [stamp(A, '2026-08-04', '08:05', '16:10')] },
      { ...AUGUST_SCHEDULE, '2026-08-05': [declared(A, 'ΑΝ', '', '')] },
    ),
    { realm, employerAfm: EMPLOYER, month: '2026-08' },
  );
  await pullMonth(
    db,
    scripted({ '2026-07-20': [stamp(A, '2026-07-20', '08:00', '16:00')] }, {}, (code, day) => {
      if (code === 'EX_BASE_08' && day === '2026-07-20') return { EX_BASE_08: { Rows: [{ Unknown: '1' }] } };
      if (code === 'EX_BASE_07' && day === '2026-07-25') return new ErganiError(400, '{"message":"x"}', 'ExecuteService');
      return undefined;
    }),
    { realm, employerAfm: EMPLOYER, month: '2026-07' },
  );
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

async function filledStore(realm: ErganiRealm = 'local'): Promise<RecordStore> {
  const db = openRecordStore(':memory:');
  cleanups.push(() => db.close());
  await fill(db, realm);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ergani-export-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The text of a page with its markup removed — what a person reads on the face of it. */
const faceOf = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the per-employee export — for an inspector, or for the employee', () => {
  it('holds every stamp of that ONE employee over the range, in date order — and nobody else’s', async () => {
    const db = await filledStore();
    const record = employeeRecord(db, A, '2026-07-01', '2026-09-30');
    expect(record.stamps.map((s) => [s.day, s.hourFrom, s.hourTo, s.inLatestRead])).toEqual([
      ['2026-07-20', '08:00', '16:00', 1],
      ['2026-08-03', '08:00', '16:00', 1],
      ['2026-08-04', '08:05', '17:30', 0],
      ['2026-08-04', '08:05', '16:10', 1],
      ['2026-08-06', '09:00', '13:00', 1],
      ['2026-08-07', '08:00', '21:00', 1],
      ['2026-08-10', '<08:00>;', '16:00"', 1],
      ['2026-08-28', '17:00', '00:30', 1],
    ]);

    const html = employeePage(record, GENERATED);
    const csv = employeeCsv(record);
    for (const out of [html, csv]) {
      expect(out).toContain(A);
      expect(out).not.toContain(C);
      expect(out).not.toContain('07:00');
      expect(out).not.toContain(B);
    }
    const face = faceOf(html);
    expect(face).toContain('ΑΦΜ εργαζομένου 000000000');
    expect(face).toContain('Περίοδος 01/07/2026 – 30/09/2026');
    expect(face).toContain('Καταγραφές (8)');
    expect(face).toContain('28/08/2026 Παρασκευή 17:00 00:30 λήξη την επόμενη ημέρα');
    expect(face).toContain('04/08/2026 Τρίτη 08:05 17:30 παλαιότερη εκδοχή — η ΕΡΓΑΝΗ δεν την απαντά πλέον');
    expect(face).toContain('04/08/2026 Τρίτη 08:05 16:10 06/08/2026');
  });

  it('never presents a day it does not know as a day without a stamp: the unread days are on its face', async () => {
    const db = await filledStore();
    const record = employeeRecord(db, A, '2026-07-01', '2026-09-30');
    expect(record.unread).toEqual([
      { from: '2026-07-25', to: '2026-07-31' },
      { from: '2026-09-01', to: '2026-09-30' },
    ]);
    const face = faceOf(employeePage(record, GENERATED));
    expect(face).toContain('δεν έχει την απάντηση της ΕΡΓΑΝΗ');
    expect(face).toContain('25/07/2026 – 31/07/2026, 01/09/2026 – 30/09/2026');

    const covered = employeeRecord(db, A, '2026-08-01', '2026-08-31');
    expect(covered.unread).toEqual([]);
    expect(faceOf(employeePage(covered, GENERATED))).toContain('Καμία: για κάθε ημέρα της περιόδου το αρχείο έχει την απάντηση');
  });

  it('says how fresh it is: the newest day held, when it was read, and how many days old', async () => {
    const face = faceOf(employeePage(employeeRecord(await filledStore(), A, '2026-08-01', '2026-08-31'), GENERATED));
    expect(face).toContain('Έως και έναν μήνα πίσω');
    expect(face).toContain('31/08/2026 , 25 ημέρες πριν από τη δημιουργία αυτής της σελίδας (αντλήθηκαν από την ΕΡΓΑΝΗ στις 24/09/2026)');
    expect(face).toContain('Δημιουργήθηκε 25/09/2026 12:00 (ώρα Ελλάδας)');
  });

  it('an empty record says it holds nothing — every day unread, no freshness claimed', () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    const record = employeeRecord(db, A, '2026-08-01', '2026-08-02');
    expect(record.unread).toEqual([{ from: '2026-08-01', to: '2026-08-02' }]);
    expect(faceOf(employeePage(record, GENERATED))).toContain('καμία — το αρχείο δεν έχει ακόμη καμία απάντηση της ΕΡΓΑΝΗ');
  });

  it('is readable with no software of ours: one self-contained file, every value escaped', async () => {
    const html = employeePage(employeeRecord(await filledStore(), A, '2026-08-01', '2026-08-31'), GENERATED);
    expect(html.startsWith('<!doctype html>\n<html lang="el">')).toBe(true);
    for (const outside of ['<script', '<link', '<img', 'src=', 'href=', 'http:', 'https:', '@import', 'url(']) {
      expect(html, outside).not.toContain(outside);
    }
    expect(html).toContain('&lt;08:00&gt;;');
    expect(html).toContain('16:00&quot;');
    expect(html).not.toContain('<08:00>');
  });

  it('the CSV is the same rows, verbatim, for a spreadsheet: BOM, «;» between fields, one line per stamp', async () => {
    const csv = employeeCsv(employeeRecord(await filledStore(), A, '2026-08-01', '2026-08-31'));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(1 + 7 + 1);
    expect(lines[0]).toBe(
      'ΑΦΜ;Ημερομηνία αναφοράς;Ημέρα;Έναρξη;Λήξη;Λήξη την επόμενη ημέρα;Κατάσταση;' +
        'Φορές στην τελευταία απάντηση της ΕΡΓΑΝΗ;Α/Α παραρτήματος;Date όπως το απέδωσε η ΕΡΓΑΝΗ',
    );
    // ⛔ The ΑΦΜ as Excel text — `="000000000"`, quoted for the CSV — so its leading zeros survive.
    const afm = '"=""000000000"""';
    expect(lines).toContain(`${afm};28/08/2026;Παρασκευή;17:00;00:30;ναι;ισχύει;1;0;28/08/2026`);
    expect(lines).toContain(`${afm};04/08/2026;Τρίτη;08:05;17:30;όχι;παλαιότερη εκδοχή — δεν απαντάται πλέον;0;0;04/08/2026`);
    expect(lines).toContain(`${afm};10/08/2026;Δευτέρα;"<08:00>;";"16:00""";όχι;ισχύει;1;0;10/08/2026`);
    expect(lines.slice(1, -1).every((line) => line.startsWith(`${afm};`))).toBe(true);
  });

  it('⛔ a record not read from the real register says so in red at the top — and a production one does not', async () => {
    const banner = 'ΔΟΚΙΜΑΣΤΙΚΑ ΣΤΟΙΧΕΙΑ — ΟΧΙ ΤΟ ΠΡΑΓΜΑΤΙΚΟ ΑΡΧΕΙΟ ΤΟΥ ΕΡΓΟΔΟΤΗ';
    const page = async (realm: ErganiRealm) =>
      employeePage(employeeRecord(await filledStore(realm), A, '2026-08-01', '2026-08-31'), GENERATED);
    const trial = await page('trial');
    expect(trial).toContain(banner);
    expect(trial).toContain('φέρει τη σήμανση «ΑΚΥΡΟ»');
    expect(await page('local')).toContain(banner);
    expect(await page('production')).not.toContain(banner);
    expect(comparisonPage(monthComparison(await filledStore('trial'), '2026-08'), GENERATED)).toContain(banner);
  });

  it('lists every employee with a row of either kind in the range — one on leave all month included', async () => {
    const db = await filledStore();
    expect(employeesIn(db, '2026-08-01', '2026-08-31')).toEqual([A, C, B]);
    expect(employeesIn(db, '2026-07-01', '2026-07-31')).toEqual([A]);
    expect(employeeRecord(db, B, '2026-08-01', '2026-08-31').stamps).toEqual([]);
    expect(() => employeeRecord(db, '12345678', '2026-08-01', '2026-08-31')).toThrow(RangeError);
    expect(() => employeeRecord(db, A, '2026-08-31', '2026-08-01')).toThrow(RangeError);
    expect(() => employeeRecord(db, A, '2026-02-30', '2026-03-01')).toThrow(RangeError);
  });
});

describe('the month-late comparison — stamped beside declared, honest about what it is', () => {
  const dayOf = (days: readonly ComparedDay[], day: string) => days.find((d) => d.day === day) as ComparedDay;

  it('states the difference mechanically, per employee per day — and judges nothing', async () => {
    const c = monthComparison(await filledStore(), '2026-08');
    expect(c.employees.map((e) => e.afm)).toEqual([A, C, B]);
    const a = c.employees[0]!.days;
    expect(a.map((d) => [d.day, d.difference])).toEqual([
      ['2026-08-03', { kind: 'intervals', deltas: [{ start: 0, end: 0 }] }],
      ['2026-08-04', { kind: 'intervals', deltas: [{ start: 5, end: 10 }] }],
      ['2026-08-05', { kind: 'declared-absence', types: ['ΑΝ'] }],
      ['2026-08-06', { kind: 'stamp-on-declared-absence', types: ['ΑΝ'] }],
      ['2026-08-07', { kind: 'interval-count', declared: 2, stamped: 1 }],
      ['2026-08-10', { kind: 'unreadable-time' }],
      // A night shift both sides: the stamp's flag and the declared end before its start both mean "the next day".
      ['2026-08-28', { kind: 'intervals', deltas: [{ start: 0, end: 0 }] }],
    ]);
    expect(a.map((d) => standing(d.difference))).toEqual(['same', 'differs', 'same', 'differs', 'differs', 'not-compared', 'same']);
    expect(c.employees[2]!.days.map((d) => d.difference)).toEqual([{ kind: 'declared-absence', types: ['ΑΔΠΠΜ'] }]);

    // Only what ΕΡΓΑΝΗ answers NOW is compared; the earlier versions ride along, marked.
    expect(dayOf(a, '2026-08-04').stampedEarlier.map((s) => s.hourTo)).toEqual(['17:30']);
    expect(dayOf(a, '2026-08-05').declared.map((s) => s.type)).toEqual(['ΑΝ']);
    expect(dayOf(a, '2026-08-05').declaredEarlier.map((s) => s.type)).toEqual(['ΕΡΓ']);
  });

  it('⚠ leave beside the ordinary hours (measured 2026-09-28) is a declared day off — never «work without a stamp»', async () => {
    // ΕΡΓΑΝΗ answers an employee on leave with the leave row AND their ordinary «ΕΡΓ» row for the same
    // day (the leave code here is the guide's §4 example).
    const onLeave = [declared(B, 'ΕΡΓ', '09:00', '17:00'), declared(B, 'ΑΔΠΠΜ', '', '')];
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    await pullMonth(
      db,
      scripted({ '2026-08-04': [stamp(B, '2026-08-04', '09:00', '17:00')] }, { '2026-08-03': onLeave, '2026-08-04': onLeave }),
      { realm: 'local', employerAfm: EMPLOYER, month: '2026-08' },
    );
    const c = monthComparison(db, '2026-08');
    const days = c.employees[0]!.days;
    expect(days.map((d) => [d.day, d.difference])).toEqual([
      ['2026-08-03', { kind: 'declared-absence', types: ['ΑΔΠΠΜ'] }],
      ['2026-08-04', { kind: 'stamp-on-declared-absence', types: ['ΑΔΠΠΜ'] }],
    ]);
    expect(days.map((d) => standing(d.difference))).toEqual(['same', 'differs']);
    const face = faceOf(comparisonPage(c, GENERATED));
    expect(face).toContain('03/08/2026 Δευτέρα ΕΡΓ 09:00–17:00 · διάλειμμα 15′ ΑΔΠΠΜ — δηλωμένη ημέρα χωρίς εργασία (ΑΔΠΠΜ), χωρίς καταγραφή');
    expect(face).not.toContain('δηλωμένη εργασία χωρίς καταγραφή κάρτας');
  });

  it('a day off declared at one branch outranks that branch\'s hours only — a day worked at another branch is compared on its hours', async () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    const range = { realm: 'local' as const, employerAfm: EMPLOYER, month: '2026-08' };
    // The seat (0) declares B resting on the 3rd and the 4th; the other branch (1) declares the 4th worked, and she stamps it there.
    await pullMonth(db, scripted({}, { '2026-08-03': [declared(B, 'ΑΝ', '', '')], '2026-08-04': [declared(B, 'ΑΝ', '', '')] }), range);
    await pullMonth(
      db,
      scripted({ '2026-08-04': [stamp(B, '2026-08-04', '09:00', '17:00')] }, { '2026-08-04': [declared(B, 'ΕΡΓ', '09:00', '17:00')] }, undefined, '1'),
      range,
    );
    const days = monthComparison(db, '2026-08').employees[0]!.days;
    expect(days.map((d) => [d.day, d.difference.kind, standing(d.difference)])).toEqual([
      ['2026-08-03', 'declared-absence', 'same'],
      ['2026-08-04', 'intervals', 'same'],
    ]);
  });

  it('⛔ a stamp at the branch that declared her day off is the finding — even when another branch declares her working', async () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    const range = { realm: 'local' as const, employerAfm: EMPLOYER, month: '2026-08' };
    // The seat (0) declares B resting on the 4th, the other branch (1) declares her 09:00–17:00 — and she covers the
    // seat that day: her stamps are at the seat, exactly the hours branch 1 declared, and nearly so on the 5th.
    const off = { '2026-08-04': [declared(B, 'ΑΝ', '', '')], '2026-08-05': [declared(B, 'ΑΝ', '', '')] };
    const worked = { '2026-08-04': [stamp(B, '2026-08-04', '09:00', '17:00')], '2026-08-05': [stamp(B, '2026-08-05', '08:58', '17:03')] };
    await pullMonth(db, scripted(worked, off), range);
    const hours = { '2026-08-04': [declared(B, 'ΕΡΓ', '09:00', '17:00')], '2026-08-05': [declared(B, 'ΕΡΓ', '09:00', '17:00')] };
    await pullMonth(db, scripted({}, hours, undefined, '1'), range);
    const days = monthComparison(db, '2026-08').employees[0]!.days;
    expect(days.map((d) => [d.day, d.difference])).toEqual([
      ['2026-08-04', { kind: 'stamp-on-declared-absence', types: ['ΑΝ'] }],
      ['2026-08-05', { kind: 'stamp-on-declared-absence', types: ['ΑΝ'] }],
    ]);
  });

  it('compares a non-«ΕΡΓ» row WITH hours on its hours — only an hour-less one is a day off — and escapes every type it names', async () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    await pullMonth(
      db,
      scripted({}, { '2026-08-03': [declared(B, 'ΥΠΕΡ', '17:00', '19:00')], '2026-08-04': [declared(B, '<i>Χ</i>&', '', '')] }),
      { realm: 'local', employerAfm: EMPLOYER, month: '2026-08' },
    );
    const c = monthComparison(db, '2026-08');
    expect(c.employees[0]!.days.map((d) => [d.day, d.difference])).toEqual([
      ['2026-08-03', { kind: 'declared-work-without-stamp' }],
      ['2026-08-04', { kind: 'declared-absence', types: ['<i>Χ</i>&'] }],
    ]);
    // ΕΡΓΑΝΗ's own text, like every other value on the page, is escaped wherever it is shown.
    const html = comparisonPage(c, GENERATED);
    expect(html).not.toContain('<i>Χ</i>');
    expect(html).toContain('δηλωμένη ημέρα χωρίς εργασία (&lt;i&gt;Χ&lt;/i&gt;&amp;), χωρίς καταγραφή');
  });

  it('a stamp on a day with no declared schedule differs; a declared «ΕΡΓ» with no hours and no stamp is the same', async () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    await pullMonth(
      db,
      scripted({ '2026-08-05': [stamp(A, '2026-08-05', '08:00', '16:00')] }, { '2026-08-06': [declared(A, 'ΕΡΓ', '', '')] }),
      { realm: 'local', employerAfm: EMPLOYER, month: '2026-08' },
    );
    const days = monthComparison(db, '2026-08').employees[0]!.days;
    expect(days.map((d) => [d.day, d.difference, standing(d.difference)])).toEqual([
      ['2026-08-05', { kind: 'stamp-without-declared-work' }, 'differs'],
      ['2026-08-06', { kind: 'no-work' }, 'same'],
    ]);
  });

  it('declared work with no stamp is shown as such', async () => {
    const db = openRecordStore(':memory:');
    cleanups.push(() => db.close());
    await pullMonth(db, scripted({}, { '2026-08-05': [declared(A, 'ΕΡΓ', '08:00', '16:00')] }), { realm: 'local', employerAfm: EMPLOYER, month: '2026-08' });
    const c = monthComparison(db, '2026-08');
    expect(c.employees[0]!.days.map((d) => d.difference)).toEqual([{ kind: 'declared-work-without-stamp' }]);
    expect(faceOf(comparisonPage(c, GENERATED))).toContain('05/08/2026 Τετάρτη ΕΡΓ 08:00–16:00 · διάλειμμα 15′ — δηλωμένη εργασία χωρίς καταγραφή κάρτας');
  });

  it('⛔⛔ says ON ITS FACE, above the first table, that it is up to a month behind, how old its newest data is, and that the accountant already checks daily', async () => {
    const html = comparisonPage(monthComparison(await filledStore(), '2026-08'), GENERATED);
    const top = faceOf(html.slice(0, html.indexOf('<table')));
    expect(top).toContain('Έως και έναν μήνα πίσω — όχι η σημερινή εικόνα.');
    expect(top).toContain('μόνο για τον προηγούμενο μήνα και παλαιότερα');
    expect(top).toContain('Νεότερη ημέρα με στοιχεία κάρτας: 31/08/2026 , 25 ημέρες πριν από τη δημιουργία αυτής της σελίδας');
    expect(top).toContain('Νεότερη ημέρα με δηλωμένο ωράριο: 31/08/2026 , 25 ημέρες');
    expect(top).toContain('Ο λογιστής σας το ελέγχει ήδη καθημερινά.');
    expect(top).toContain('Δεν είναι ο έλεγχος και δεν είναι δίχτυ ασφαλείας');
    expect(top).toContain('Μια διαφορά δεν είναι λάθος ούτε παράβαση');
    // Not in a tooltip: the page has no title attributes at all.
    expect(html).not.toMatch(/\stitle=/);
  });

  it('the staleness is counted from the day the page is made — a page made later says its data is older', async () => {
    const db = await filledStore();
    const later = Date.parse('2026-11-02T09:00:00+02:00');
    expect(faceOf(comparisonPage(monthComparison(db, '2026-08'), later))).toContain('31/08/2026 , 63 ημέρες πριν');
  });

  it('shows each difference in words, the earlier versions marked, and a count per employee', async () => {
    const face = faceOf(comparisonPage(monthComparison(await filledStore(), '2026-08'), GENERATED));
    expect(face).toContain('ΑΦΜ 000000000 Ημέρες με διαφορά: 3 · ίδιες: 3 · δεν συγκρίθηκαν: 1');
    expect(face).toContain('03/08/2026 Δευτέρα ΕΡΓ 08:00–16:00 · διάλειμμα 15′ 08:00–16:00 ίδιες ώρες');
    expect(face).toContain(
      '04/08/2026 Τρίτη ΕΡΓ 08:00–16:00 · διάλειμμα 15′ 08:05–16:10 παλαιότερη εκδοχή, δεν απαντάται πλέον: 08:05–17:30 ' +
        'έναρξη 5′ αργότερα · λήξη 10′ αργότερα',
    );
    expect(face).toContain(
      '05/08/2026 Τετάρτη ΑΝ παλαιότερη εκδοχή, δεν απαντάται πλέον: ΕΡΓ 08:00–16:00 · διάλειμμα 15′ — δηλωμένη ημέρα χωρίς εργασία (ΑΝ), χωρίς καταγραφή',
    );
    expect(face).toContain('06/08/2026 Πέμπτη ΑΝ 09:00–13:00 καταγραφή κάρτας σε ημέρα που το ωράριο δηλώνει ΑΝ');
    expect(face).toContain(
      '07/08/2026 Παρασκευή ΕΡΓ 08:00–12:00 · διάλειμμα 15′ ΕΡΓ 17:00–21:00 · διάλειμμα 15′ 08:00–21:00 ' +
        'διαφορετικός αριθμός διαστημάτων: δηλωμένα 2, στην κάρτα 1',
    );
    expect(face).toContain('&lt;08:00&gt;;–16:00&quot; δεν συγκρίθηκε: μια ώρα λείπει ή έχει μορφή που δεν αναγνωρίζεται');
    expect(face).toContain('28/08/2026 Παρασκευή ΕΡΓ 17:00–00:30 · διάλειμμα 15′ 17:00–00:30 (λήξη την επόμενη ημέρα) ίδιες ώρες');
    expect(face).toContain('ΑΦΜ 999999999 Ημέρες με διαφορά: 0 · ίδιες: 1 · δεν συγκρίθηκαν: 0');
    expect(face).toContain('ΑΔΠΠΜ — δηλωμένη ημέρα χωρίς εργασία (ΑΔΠΠΜ), χωρίς καταγραφή');
  });

  it('⛔ never compares a day the record does not hold both answers for — it says so instead', async () => {
    const c = monthComparison(await filledStore(), '2026-07');
    expect(c.unread).toEqual({
      stamps: [{ from: '2026-07-25', to: '2026-07-31' }],
      // The stamps' walk stopped on the 25th; the schedule's went on (a stop is per service), so only the
      // 20th, which it could not recognise, is unread.
      schedule: [{ from: '2026-07-20', to: '2026-07-20' }],
    });
    // The 20th has a stamp and no schedule answer: NOT "a stamp without declared work".
    expect(c.employees).toEqual([
      { afm: A, days: [expect.objectContaining({ day: '2026-07-20', difference: { kind: 'not-read', services: ['EX_BASE_08'] } })] },
    ]);
    const face = faceOf(comparisonPage(c, GENERATED));
    expect(face).toContain('δεν γίνεται σύγκριση');
    expect(face).toContain('Κάρτα (EX_BASE_07): 25/07/2026 – 31/07/2026');
    expect(face).toContain('Ωράριο (EX_BASE_08): 20/07/2026');
    expect(face).not.toContain('Ωράριο (EX_BASE_08): 20/07/2026, 25/07/2026');
    expect(face).toContain('δεν συγκρίθηκε: το αρχείο δεν έχει το ωράριο αυτής της ημέρας');
    expect(face).not.toContain('καταγραφή κάρτας χωρίς δηλωμένο ωράριο');

    const september = monthComparison(await filledStore(), '2026-09');
    expect(september.employees).toEqual([]);
    expect(september.unread.stamps).toEqual([{ from: '2026-09-01', to: '2026-09-30' }]);
  });
});

describe('the CLI — files out, nothing sent, the record untouched', () => {
  async function storeFile(): Promise<string> {
    const path = join(tempDir(), 'records.sqlite');
    const db = openRecordStore(path);
    await fill(db);
    db.close();
    return path;
  }

  it('writes one employee’s page and CSV, every employee’s pair, or the month’s comparison', async () => {
    const store = await storeFile();
    const out = join(tempDir(), 'exports');
    const env = { ERGANI_RECORDS_DB: store };
    const range = ['--from', '2026-08-01', '--to', '2026-08-31', '--out', out];

    const one = runExport(exportCommand(['employee', '--afm', A, ...range], env), GENERATED);
    // Each request gets a new folder of its own, so a hand-over never carries another request's files.
    const oneFolder = dirname(one[0]!);
    expect(dirname(oneFolder)).toBe(out);
    expect(basename(oneFolder)).toMatch(/^karta-2026-08-01-2026-08-31-\d{8}T\d{6}$/);
    expect(one).toEqual([
      join(oneFolder, `karta-${A}-2026-08-01-2026-08-31.html`),
      join(oneFolder, `karta-${A}-2026-08-01-2026-08-31.csv`),
    ]);
    expect(readdirSync(oneFolder)).toHaveLength(2);
    const page = readFileSync(one[0]!, 'utf8');
    expect(page).toContain('Καταγραφές (7)');
    expect(page).not.toContain(C);

    const all = runExport(exportCommand(['employee', '--all', ...range], env), GENERATED);
    expect(all).toHaveLength(6);
    expect(new Set(all.map((file) => dirname(file))).size).toBe(1);
    expect(dirname(all[0]!)).not.toBe(oneFolder);
    expect(readdirSync(dirname(all[0]!)).sort()).toEqual([
      `karta-${A}-2026-08-01-2026-08-31.csv`,
      `karta-${A}-2026-08-01-2026-08-31.html`,
      `karta-${C}-2026-08-01-2026-08-31.csv`,
      `karta-${C}-2026-08-01-2026-08-31.html`,
      `karta-${B}-2026-08-01-2026-08-31.csv`,
      `karta-${B}-2026-08-01-2026-08-31.html`,
    ].sort());
    const compare = runExport(exportCommand(['compare', '--month', '2026-08', '--out', out], env), GENERATED);
    expect(compare).toHaveLength(1);
    expect(basename(compare[0]!)).toBe('sygkrisi-2026-08.html');
    expect(readdirSync(out)).toHaveLength(3);
    // ⛔ The same request again in the same second is refused, never merged into the earlier folder.
    expect(() => runExport(exportCommand(['employee', '--afm', A, ...range], env), GENERATED)).toThrow(/EEXIST/);
    expect(readdirSync(oneFolder)).toHaveLength(2);
  });

  it('⛔ opens the record read-only: the store file is byte-for-byte unchanged, and the handle refuses a write', async () => {
    const store = await storeFile();
    const before = readFileSync(store);
    const out = join(tempDir(), 'exports');
    runExport(exportCommand(['employee', '--all', '--from', '2026-07-01', '--to', '2026-08-31', '--out', out], { ERGANI_RECORDS_DB: store }), GENERATED);
    runExport(exportCommand(['compare', '--month', '2026-07', '--out', out], { ERGANI_RECORDS_DB: store }), GENERATED);
    expect(readFileSync(store).equals(before)).toBe(true);

    const db = openRecordStoreForReading(store);
    try {
      expect(() => db.exec("INSERT INTO schema_migrations VALUES (99, 'x', 'y')")).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });

  it('refuses a file that is not this code’s record store, rather than reading it on a guess', async () => {
    const dir = tempDir();
    const empty = join(dir, 'empty.sqlite');
    writeFileSync(empty, '');
    expect(() => openRecordStoreForReading(empty)).toThrow('not a record store');
    const store = await storeFile();
    const newer = [...recordMigrations(), { version: 2, name: '002-later.sql', sql: '' }];
    expect(() => openRecordStoreForReading(store, newer)).toThrow(/schema \(001-the-record\.sql\) is not this code's/);
  });

  it('checks the command line before opening anything — and never echoes a value back', async () => {
    const store = await storeFile();
    const out = join(tempDir(), 'x');
    const env = { ERGANI_RECORDS_DB: store };
    const range = ['--from', '2026-08-01', '--to', '2026-08-31', '--out', out];
    const refused = (argv: string[], e: NodeJS.ProcessEnv = env) => {
      try {
        exportCommand(argv, e);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`accepted: ${argv.join(' ')}`);
    };

    expect(refused(['employee', '--afm', A, ...range], {})).toContain('ERGANI_RECORDS_DB is not set');
    expect(refused(['employee', '--afm', A, ...range], { ERGANI_RECORDS_DB: 'records.sqlite' })).toContain('absolute');
    expect(refused(['employee', '--afm', A, ...range], { ERGANI_RECORDS_DB: `${store}.typo` })).toContain('no record store');
    expect(refused(['employee', '--afm', A, '--from', '2026-08-01', '--to', '2026-08-31'])).toContain('--out is required');
    expect(refused(['employee', '--afm', A, '--from', '2026-08-01', '--to', '2026-08-31', '--out', 'exports'])).toContain('absolute');
    // ⛔ Never into the repository: the files hold ΑΦΜ and hours.
    for (const inside of [REPO, join(REPO, 'exports'), join(REPO, 'src', 'export')]) {
      expect(refused(['employee', '--afm', A, '--from', '2026-08-01', '--to', '2026-08-31', '--out', inside])).toContain(
        'inside a code folder',
      );
    }
    expect(refused(['employee', ...range])).toContain('exactly one of --afm');
    expect(refused(['employee', '--afm', A, '--all', ...range])).toContain('exactly one of --afm');
    const badAfm = refused(['employee', '--afm', '12345678', ...range]);
    expect(badAfm).toContain('nine digits');
    expect(badAfm).not.toContain('12345678');
    expect(refused(['employee', '--afm', A, '--from', '2026-08-01', '--out', out])).toContain('--from and --to');
    expect(refused(['employee', '--afm', A, '--from', '2026-08-01', '--to', '2026-13-01', '--out', out])).toContain('YYYY-MM-DD');
    expect(refused(['employee', '--afm', A, '--month', '2026-08', ...range])).toContain('not --month');
    expect(refused(['compare', '--out', out])).toContain('--month');
    expect(refused(['compare', '--month', '2026-8', '--out', out])).toContain('YYYY-MM');
    expect(refused(['compare', '--month', '2026-08', '--afm', A, '--out', out])).toContain('--month only');
    expect(refused(['--afm', A, ...range])).toContain('employee or compare');
    expect(() => exportCommand(['employee', '--afm', A, '--purge', ...range], env)).toThrow();

    expect(exportCommand(['employee', '--afm', A, ...range], env)).toEqual({
      kind: 'employee',
      store,
      out,
      afm: A,
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });
});

describe('⛔⛔ the fence: src/export reads the record store and nothing else', () => {
  const dir = fileURLToPath(new URL('../src/export/', import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('imports only node built-ins, its own modules and the record store — never src/ergani, never the pull', () => {
    expect(sources.map((s) => s.file).sort()).toEqual(['cli.ts', 'model.ts', 'render.ts']);
    const allowed = /^(node:[a-z]+|\.\/(model|render)\.js|\.\.\/records\/store\.js|\.\.\/code-folders\.js)$/;
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const s of specifiers) expect(s, `${file} imports ${s}`).toMatch(allowed);
    }
    // And the store it reads, the files it carries (its migrations), and the path fence it asks import nothing of
    // ΕΡΓΑΝΗ at run time.
    const leaves: Record<string, RegExp> = {
      '../src/records/store.ts': /^(node:[a-z]+|\.\.\/assets\.js)$/,
      '../src/assets.ts': /^node:[a-z]+$/,
      '../src/code-folders.ts': /^node:[a-z]+$/,
    };
    for (const [module, allowedHere] of Object.entries(leaves)) {
      const text = readFileSync(fileURLToPath(new URL(module, import.meta.url)), 'utf8');
      for (const m of text.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)) expect(m[1], module).toMatch(allowedHere);
    }
  });

  it('opens no client, calls no filing, reaches no network', () => {
    for (const { file, text } of sources) {
      for (const forbidden of [/ErganiClient/, /submitWorkCard/, /\bfetch\s*\(/, /https?:/, /yeka\.gr/]) {
        expect(text, `${file} ~ ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});
