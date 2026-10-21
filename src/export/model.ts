// SPDX-License-Identifier: EUPL-1.2
import type { DatabaseSync } from 'node:sqlite';
import {
  daysRead,
  heldSchedule,
  heldStamps,
  newestRead,
  pullLog,
  type HeldSchedule,
  type HeldStamp,
  type ReadDay,
} from '../records/store.js';

/**
 * WHAT THE EXPORT SAYS, before it is written as a page — read from the record store (`src/records/`)
 * and NOTHING else.
 *
 * ⛔⛔ This module never opens a client of ΕΡΓΑΝΗ and never sends a byte anywhere: it reads the record
 * store (src/records/), which is the employer's own copy. `test/export.test.ts` asserts that nothing in `src/export/` imports
 * from `src/ergani/` or reaches the network.
 *
 * ── ⚠ "NO ROW" AND "NOT READ" ARE DIFFERENT STATEMENTS ────────────────────────────────────────────
 * The record only knows a day it has ΕΡΓΑΝΗ's answer for. A day never pulled — this month, which
 * ΕΡΓΑΝΗ will not answer yet, or a day a pull failed on — holds no rows, and printing it as "no stamp"
 * would be a false statement to an inspector about a named person's working day. So every view carries
 * the days it does NOT know, and the comparison refuses to compare a day either service was not read for.
 *
 * ── ⚠ THE RECORD IS UP TO A MONTH BEHIND, BY CONSTRUCTION ─────────────────────────────────────────
 * `EX_BASE_07/08` answer only for the previous month and earlier («Περιορισμός σε ημ/νιες προηγούμενου
 * μήνα και πίσω», measured on both sides of the line). Every view carries the newest day the record holds, so
 * the page can say it, every time.
 */

export const STAMPS = 'EX_BASE_07';
export const SCHEDULE = 'EX_BASE_08';
export type Service = typeof STAMPS | typeof SCHEDULE;

/** A run of consecutive days, `YYYY-MM-DD`, inclusive at both ends. */
export interface DayRange {
  from: string;
  to: string;
}

/** Where the record's data came from, and how fresh it is. */
export interface RecordSource {
  /** The ΕΡΓΑΝΗ realms the record's pulls read — one, by the store's rule; none if nothing was ever pulled. */
  realms: string[];
  /** The newest day with a successful `EX_BASE_07` read, and when it was read. */
  newestStamps: ReadDay | undefined;
  /** The newest day with a successful `EX_BASE_08` read, and when it was read. */
  newestSchedule: ReadDay | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One employee's stamps — the export an inspector, or the employee, reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every stamp the record holds for ONE employee over a range — for a labour inspector, or for the
 * employee asking what the employer holds (ΥΑ 113169/2023: per-employee access to their own card data is
 * a legal requirement). ⛔ Only that employee's rows: the page for one person never carries another's.
 */
export interface EmployeeRecord {
  /** The employee's ΑΦΜ — the only identifier `EX_BASE_07` carries. No name is looked up. */
  afm: string;
  from: string;
  to: string;
  source: RecordSource;
  /**
   * Every row, in date order — including rows ΕΡΓΑΝΗ no longer answers (`inLatestRead` 0), which the
   * record keeps and the page marks: a stamp later corrected upstream is still part of the record.
   */
  stamps: HeldStamp[];
  /** The days of the range the record holds no `EX_BASE_07` answer for. */
  unread: DayRange[];
}

export function employeeRecord(db: DatabaseSync, afm: string, from: string, to: string): EmployeeRecord {
  assertAfm(afm);
  const days = daysBetween(from, to);
  return {
    afm,
    from,
    to,
    source: recordSource(db),
    stamps: heldStamps(db, from, to).filter((s) => s.afm === afm),
    unread: runs(unreadDays(db, STAMPS, days)),
  };
}

/**
 * Every ΑΦΜ with a stamp or a declared-schedule row in the range, in order — one export each. An
 * employee with schedule rows and no stamps (on leave all month) is included: their export truthfully
 * says so.
 */
export function employeesIn(db: DatabaseSync, from: string, to: string): string[] {
  daysBetween(from, to);
  const afms = [...heldStamps(db, from, to), ...heldSchedule(db, from, to)].map((r) => r.afm);
  return [...new Set(afms)].sort();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The month-late comparison: what was stamped beside what was declared
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One month of `EX_BASE_07` (stamped) beside `EX_BASE_08` (declared), per employee per day — π.δ.
 * 62/2025 άρθρο 581 §3's separate €10,500 is for a card that does not match the declared schedule.
 *
 * ⚠ A CROSS-CHECK, NOT A CONTROL. Under απολογιστικό the accountant already reconciles stamps against
 * the schedule daily, per employee, and re-declares afterwards; this is the same question asked a
 * month later. ⛔ NOT A RULES ENGINE: a moved rest day, overtime, a sixth day are legitimate and
 * re-declared after the fact. The comparison states the difference mechanically and judges nothing —
 * no tolerance, no "violation", no severity.
 */
export interface MonthComparison {
  /** `YYYY-MM`. */
  month: string;
  source: RecordSource;
  /** The days of the month the record holds no answer for, per service. Those days are not compared. */
  unread: { stamps: DayRange[]; schedule: DayRange[] };
  /** Every employee with a row of either kind in the month, by ΑΦΜ. */
  employees: Array<{ afm: string; days: ComparedDay[] }>;
}

/** One employee's day: both sides, and the difference between them. */
export interface ComparedDay {
  day: string;
  /** Declared rows ΕΡΓΑΝΗ currently answers — what is compared. */
  declared: HeldSchedule[];
  /** Declared rows ΕΡΓΑΝΗ no longer answers (re-declared since): shown, never compared. */
  declaredEarlier: HeldSchedule[];
  stamped: HeldStamp[];
  stampedEarlier: HeldStamp[];
  difference: Difference;
}

/**
 * The difference between one day's declared intervals and its stamped ones, stated mechanically.
 * Deltas are STAMPED minus DECLARED, in minutes: positive is later than declared.
 */
export type Difference =
  /** The record has no answer for this day from one service or both — nothing is compared. */
  | { kind: 'not-read'; services: Service[] }
  /** An hour is missing or in a form not recognised — nothing is compared, the values are shown. */
  | { kind: 'unreadable-time' }
  /** No declared working interval and no stamp — leave, a rest day. */
  | { kind: 'no-work' }
  /** The schedule declares the day off — a row of another type than «ΕΡΓ», with no hours — and nothing was stamped. */
  | { kind: 'declared-absence'; types: string[] }
  /** Stamped on a day the schedule declares off. */
  | { kind: 'stamp-on-declared-absence'; types: string[] }
  | { kind: 'stamp-without-declared-work' }
  | { kind: 'declared-work-without-stamp' }
  /** A different number of intervals — a σπαστό ωράριο against one long stamp, say. Not paired up. */
  | { kind: 'interval-count'; declared: number; stamped: number }
  /** As many stamped intervals as declared ones, paired in time order. All zero: the same hours. */
  | { kind: 'intervals'; deltas: Array<{ start: number; end: number }> };

/** Whether a day differs, matches, or could not be compared. */
export function standing(difference: Difference): 'differs' | 'same' | 'not-compared' {
  switch (difference.kind) {
    case 'not-read':
    case 'unreadable-time':
      return 'not-compared';
    case 'no-work':
    case 'declared-absence':
      return 'same';
    case 'intervals':
      return difference.deltas.every((d) => d.start === 0 && d.end === 0) ? 'same' : 'differs';
    default:
      return 'differs';
  }
}

export function monthComparison(db: DatabaseSync, month: string): MonthComparison {
  const days = daysOfMonth(month);
  const [from, to] = [days[0] as string, days.at(-1) as string];
  const unreadStamps = new Set(unreadDays(db, STAMPS, days));
  const unreadSchedule = new Set(unreadDays(db, SCHEDULE, days));
  const stamps = heldStamps(db, from, to);
  const schedule = heldSchedule(db, from, to);

  const afms = [...new Set([...stamps, ...schedule].map((r) => r.afm))].sort();
  const employees = afms.map((afm) => {
    const mine = { stamps: stamps.filter((s) => s.afm === afm), schedule: schedule.filter((s) => s.afm === afm) };
    const daysWithRows = [...new Set([...mine.stamps, ...mine.schedule].map((r) => r.day))].sort();
    return {
      afm,
      days: daysWithRows.map((day): ComparedDay => {
        const onDay = <R extends { day: string; inLatestRead: number }>(rows: R[], current: boolean) =>
          rows.filter((r) => r.day === day && (r.inLatestRead > 0) === current);
        const declared = onDay(mine.schedule, true);
        const stamped = onDay(mine.stamps, true);
        const notRead = [unreadStamps.has(day) ? STAMPS : undefined, unreadSchedule.has(day) ? SCHEDULE : undefined].filter(
          (s): s is Service => s !== undefined,
        );
        return {
          day,
          declared,
          declaredEarlier: onDay(mine.schedule, false),
          stamped,
          stampedEarlier: onDay(mine.stamps, false),
          difference: notRead.length > 0 ? { kind: 'not-read', services: notRead } : compare(declared, stamped),
        };
      }),
    };
  });

  return {
    month,
    source: recordSource(db),
    unread: { stamps: runs([...unreadStamps]), schedule: runs([...unreadSchedule]) },
    employees,
  };
}

/** A span of working time, in minutes from the reference day's midnight. `end` may pass 1440. */
interface Interval {
  start: number;
  end: number;
}

/** The ΨΟΧΕ type of a working row — measured: «ΕΡΓ» rows are the ones that carry hours. */
const WORK_TYPE = 'ΕΡΓ';

/**
 * ⚠ A DECLARED DAY OFF OUTRANKS THE ORDINARY HOURS BESIDE IT. Measured (2026-09-28): for an employee on leave,
 * ΕΡΓΑΝΗ answers the leave row AND their ordinary «ΕΡΓ» rows for the same day. Compared on its hours,
 * every day of that leave would read «δηλωμένη εργασία χωρίς καταγραφή» — a false finding about a named
 * person, on the page an inspector may be handed. So a row of another type with no hours (leave, rest)
 * makes the day a declared absence; a stamp on it is the finding.
 * ⓘ Deliberately ANY hour-less type other than «ΕΡΓ», not a list of codes: a declared working day
 * carries its hours — that is what the ΨΟΧΕ declares — so a type with none declares no work, whether or
 * not this tool has met its code before. A non-«ΕΡΓ» row WITH hours (an hourly leave, overtime) has not
 * been seen, and is compared on its hours as before (export.test.ts).
 */
function compare(declared: readonly HeldSchedule[], stamped: readonly HeldStamp[]): Difference {
  // ⓘ PER BRANCH: a schedule is declared branch by branch, and each stamp carries its branch. A day off declared at one
  // branch outranks that branch's hours only, and is judged against that branch's own stamps: a stamp THERE is the
  // finding, even when another branch declares her working that day. The other branches' hours are compared with the
  // other branches' stamps — a person resting at the seat while working at another branch worked that day. The day is
  // a declared absence only when every branch that declares it declares it off.
  const offAt = new Map<string, string[]>();
  const working: HeldSchedule[] = [];
  for (const branch of new Set(declared.map((r) => r.branch))) {
    const rows = declared.filter((r) => r.branch === branch);
    const offRows = rows.filter((r) => r.type !== WORK_TYPE && r.hourFrom === '' && r.hourTo === '');
    if (offRows.length > 0) offAt.set(branch, [...new Set(offRows.map((r) => r.type))]);
    else working.push(...rows);
  }
  const typesAt = (branches: Iterable<string>) => [...new Set([...branches].flatMap((b) => offAt.get(b) ?? []))];
  const onDayOff = new Set(stamped.filter((s) => offAt.has(s.branch)).map((s) => s.branch));
  if (onDayOff.size > 0) return { kind: 'stamp-on-declared-absence', types: typesAt(onDayOff) };
  if (offAt.size > 0 && working.length === 0) {
    const types = typesAt(offAt.keys());
    return stamped.length === 0 ? { kind: 'declared-absence', types } : { kind: 'stamp-on-declared-absence', types };
  }
  const planned = declaredIntervals(working);
  const worked = stampedIntervals(stamped);
  if (planned === undefined || worked === undefined) return { kind: 'unreadable-time' };
  if (planned.length === 0 && worked.length === 0) return { kind: 'no-work' };
  if (planned.length === 0) return { kind: 'stamp-without-declared-work' };
  if (worked.length === 0) return { kind: 'declared-work-without-stamp' };
  if (planned.length !== worked.length) return { kind: 'interval-count', declared: planned.length, stamped: worked.length };
  const byStart = (a: Interval, b: Interval) => a.start - b.start || a.end - b.end;
  const [p, w] = [[...planned].sort(byStart), [...worked].sort(byStart)];
  return { kind: 'intervals', deltas: p.map((d, i) => ({ start: w[i]!.start - d.start, end: w[i]!.end - d.end })) };
}

/**
 * The declared working intervals, or `undefined` if an hour cannot be read. A row with NO hours is a
 * day without a working interval (leave, rest) — normal, never an error. A declared end earlier than
 * its start runs past midnight: that is the only reading of it that is a span of time at all.
 */
function declaredIntervals(rows: readonly HeldSchedule[]): Interval[] | undefined {
  const intervals: Interval[] = [];
  for (const row of rows) {
    if (row.hourFrom === '' && row.hourTo === '') continue;
    const [start, end] = [minutesOf(row.hourFrom), minutesOf(row.hourTo)];
    if (start === undefined || end === undefined) return undefined;
    intervals.push({ start, end: end < start ? end + 1440 : end });
  }
  return intervals;
}

/** The stamped intervals, or `undefined` if an hour cannot be read. The night flag moves the end a day. */
function stampedIntervals(rows: readonly HeldStamp[]): Interval[] | undefined {
  const intervals: Interval[] = [];
  for (const row of rows) {
    const [start, end] = [minutesOf(row.hourFrom), minutesOf(row.hourTo)];
    if (start === undefined || end === undefined) return undefined;
    intervals.push({ start, end: end + (row.endsNextDay ? 1440 : 0) });
  }
  return intervals;
}

/**
 * `HH:MM` (or `HH:MM:SS`, seconds dropped) as minutes after midnight; anything else `undefined`.
 * ⚠ The hour formats of `EX_BASE_07/08` are UNMEASURED — no real row has been seen. A form this does not
 * recognise is never guessed at: the day is shown as not compared, with the values as ΕΡΓΑΝΗ sent them.
 */
function minutesOf(hour: string): number | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(hour);
  return m === null ? undefined : Number(m[1]) * 60 + Number(m[2]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What the record knows, and does not
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function recordSource(db: DatabaseSync): RecordSource {
  return {
    realms: [...new Set(pullLog(db).map((p) => p.realm))].sort(),
    newestStamps: newestRead(db, STAMPS),
    newestSchedule: newestRead(db, SCHEDULE),
  };
}

/**
 * The days (of `days`) the record holds no successful read of `service` for, for at least one of the
 * branches it has pulled. A store that was never pulled knows no day at all.
 */
function unreadDays(db: DatabaseSync, service: Service, days: readonly string[]): string[] {
  if (days.length === 0) return [];
  const branches = [...new Set(pullLog(db).map((p) => p.branch))];
  const read = new Set(
    daysRead(db, days[0] as string, days.at(-1) as string)
      .filter((r) => r.service === service)
      .map((r) => `${r.branch} ${r.day}`),
  );
  return days.filter((day) => branches.length === 0 || branches.some((b) => !read.has(`${b} ${day}`)));
}

/** Sorted `YYYY-MM-DD` days as runs of consecutive days. */
function runs(days: readonly string[]): DayRange[] {
  const out: DayRange[] = [];
  for (const day of [...days].sort()) {
    const last = out.at(-1);
    if (last !== undefined && nextDay(last.to) === day) last.to = day;
    else out.push({ from: day, to: day });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Days, months and ΑΦΜ — checked, never guessed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A nine-digit ΑΦΜ, as the record stores it. */
export function assertAfm(afm: string): void {
  if (!/^\d{9}$/.test(afm)) throw new RangeError('an ΑΦΜ is nine digits');
}

/** `YYYY-MM-DD` as a UTC instant, or a RangeError if it is not a real calendar day. */
function utcDay(day: string, what: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = m === null ? NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`${what} must be a calendar day written YYYY-MM-DD`);
  }
  return t;
}

const nextDay = (day: string) => new Date(utcDay(day, 'day') + 86_400_000).toISOString().slice(0, 10);

/** Every day from `from` to `to`, inclusive, in order. */
export function daysBetween(from: string, to: string): string[] {
  const [start, end] = [utcDay(from, 'the first day'), utcDay(to, 'the last day')];
  if (start > end) throw new RangeError('the first day is after the last day');
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** Every day of `YYYY-MM`, in order. */
export function daysOfMonth(month: string): string[] {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (m === null) throw new RangeError('the month must be written YYYY-MM');
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  return daysBetween(`${month}-01`, last);
}
