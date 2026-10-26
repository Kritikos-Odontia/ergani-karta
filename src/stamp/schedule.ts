// SPDX-License-Identifier: EUPL-1.2
import { readSchedule, type ReadClient } from '../ergani/exbase.js';
import type { ScheduleRow } from '../ergani/types.js';
import { addDays, athensTime } from './athens.js';
import { nationalHoliday } from './holidays.js';
import { daysBetween } from '../export/model.js';
import { isoOf, type StampStore } from './store.js';

/**
 * WHO IS DUE TODAY — from ΕΡΓΑΝΗ's own declared schedule (EX_BASE_08), read through the API, branch by branch (each
 * with its own login: the schedule is declared per branch).
 *
 * ── ⚠ THE SCHEDULE IS READ A MONTH LATE, BY THE MINISTRY'S RULE ─────────────────────────────────────
 * EX_BASE_08 answers only for «ημ/νιες προηγούμενου μήνα και πίσω» — enforced, measured (exbase.ts). So today's
 * declared hours cannot be read today. What CAN be read is the same weekday in the latest week ΕΡΓΑΝΗ will answer
 * (on Friday 2 October, Friday 25 September), and that is taken as today's. That is right on an ordinary day for a
 * fixed weekly pattern (the usual case in a dental practice). ⚠ Stated once, as fact: it can be up
 * to ~5 weeks old — a person back from leave since then is missed, a person newly on leave raises a false alarm, a
 * public holiday raises alarms unless the owner marks it quiet, and the accountant's later re-declarations
 * (απολογιστικό) are not seen. The alarm says «check»; it never files or changes anything.
 *
 * ⓘ One read a day (and a retry every 15 minutes while it fails) — a handful of calls, never per page view.
 */

/** Retry a failed read after this long. */
export const SCHEDULE_RETRY_MS = 15 * 60_000;

/** The ΨΟΧΕ type of a working row («ΕΡΓ» rows carry the hours — measured; export/model.ts). */
const WORK_TYPE = 'ΕΡΓ';

/** The day ΕΡΓΑΝΗ is asked about for `today`: the latest day of an earlier month on the same weekday. */
export function sourceDayFor(today: string): string {
  const lastOfPrevious = addDays(`${today.slice(0, 7)}-01`, -1);
  const want = new Date(`${today}T12:00:00Z`).getUTCDay();
  let day = lastOfPrevious;
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== want) day = addDays(day, -1);
  return day;
}

export interface ScheduleRead {
  branch: string;
  forDay: string;
  sourceDay: string;
  atMs: number;
  rows: ScheduleRow[] | undefined;
  error: string | undefined;
}

/** The latest read of `branch`'s schedule for `day`, successful or not. */
export function latestScheduleRead(db: StampStore, branch: string, day: string): ScheduleRead | undefined {
  const r = db
    .prepare('SELECT * FROM schedule_reads WHERE branch = ? AND for_day = ? ORDER BY at_ms DESC, id DESC LIMIT 1')
    .get(branch, day);
  if (r === undefined) return undefined;
  return {
    branch,
    forDay: String(r['for_day']),
    sourceDay: String(r['source_day']),
    atMs: Number(r['at_ms']),
    rows: r['rows'] === null ? undefined : (JSON.parse(String(r['rows'])) as ScheduleRow[]),
    error: r['error'] === null ? undefined : String(r['error']),
  };
}

/** The latest SUCCESSFUL read of `branch`'s schedule for `day`. */
export function scheduleForDay(db: StampStore, branch: string, day: string): ScheduleRead | undefined {
  const r = db
    .prepare(
      'SELECT * FROM schedule_reads WHERE branch = ? AND for_day = ? AND rows IS NOT NULL ORDER BY at_ms DESC, id DESC LIMIT 1',
    )
    .get(branch, day);
  if (r === undefined) return undefined;
  return {
    branch,
    forDay: String(r['for_day']),
    sourceDay: String(r['source_day']),
    atMs: Number(r['at_ms']),
    rows: JSON.parse(String(r['rows'])) as ScheduleRow[],
    error: undefined,
  };
}

/**
 * Read today's stand-in for the client's branch from ΕΡΓΑΝΗ if there is no good read yet and the last failure is not
 * too recent.
 */
export async function ensureSchedule(db: StampStore, client: ReadClient, nowMs: number): Promise<ScheduleRead | undefined> {
  const today = athensTime(nowMs).date;
  const good = scheduleForDay(db, client.branchCode, today);
  if (good !== undefined) return good;
  const last = latestScheduleRead(db, client.branchCode, today);
  if (last !== undefined && nowMs - last.atMs < SCHEDULE_RETRY_MS) return undefined;
  const read = await readScheduleNow(db, client, nowMs);
  return read.rows === undefined ? undefined : read;
}

/** Ask ΕΡΓΑΝΗ now, whatever is held — and record the answer or the failure. `check` uses it to prove the login reads. */
export async function readScheduleNow(db: StampStore, client: ReadClient, nowMs: number): Promise<ScheduleRead> {
  const today = athensTime(nowMs).date;
  const sourceDay = sourceDayFor(today);
  let rows: ScheduleRow[] | undefined;
  let error: string | undefined;
  try {
    rows = await readSchedule(client, sourceDay);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 1000) : String(e).slice(0, 1000);
  }
  db.prepare('INSERT INTO schedule_reads (branch, for_day, source_day, at_ms, rows, error) VALUES (?, ?, ?, ?, ?, ?)').run(
    client.branchCode,
    today,
    sourceDay,
    nowMs,
    rows === undefined ? null : JSON.stringify(rows),
    error ?? null,
  );
  return { branch: client.branchCode, forDay: today, sourceDay, atMs: nowMs, rows, error };
}

/** One person's declared day, as the alarms need it. */
export interface DeclaredDay {
  afm: string;
  /** A declared day off (a row of another type than «ΕΡΓ» with no hours) — outranks the hours beside it. */
  off: boolean;
  /**
   * The declared working intervals, `HH:MM`, in time order — ONE PER ROW. ⚠⚠ A σπαστό ωράριο is two intervals and is
   * kept as two: a forgotten ΛΗΞΗ at noon or a forgotten ΕΝΑΡΞΗ in the afternoon is exactly the missed card that
   * silently turns a split shift into one long one (docs/RULES.md, «Split shifts»), so each interval is checked on its own.
   * Empty on a day off.
   */
  intervals: Array<{ start: string; end: string }>;
}

/**
 * The declared day per ΑΦΜ. ⚠ A declared day off OUTRANKS the ordinary hours beside it — measured: a person on
 * leave is answered with the leave row AND their ordinary «ΕΡΓ» rows (the comparison page reads it the same way,
 * export/model.ts). Rows with hours are intervals, in time order.
 */
export function declaredDays(rows: readonly ScheduleRow[]): DeclaredDay[] {
  const byAfm = new Map<string, ScheduleRow[]>();
  for (const row of rows) byAfm.set(row.Afm, [...(byAfm.get(row.Afm) ?? []), row]);
  return [...byAfm].map(([afm, own]) => {
    const off = own.some((r) => r.Type !== WORK_TYPE && r.HourFrom === '' && r.HourTo === '');
    const intervals = off
      ? []
      : own
          .filter((r) => r.HourFrom !== '' && r.HourTo !== '')
          .map((r) => ({ start: r.HourFrom.slice(0, 5), end: r.HourTo.slice(0, 5) }))
          .sort((a, b) => a.start.localeCompare(b.start));
    return { afm, off, intervals };
  });
}

/** Is `day` marked closed? The latest mark for the day decides: a mark can be withdrawn (`markQuietDay(…, false)`). */
export function isQuietDay(db: StampStore, day: string): boolean {
  const row = db.prepare('SELECT quiet FROM quiet_days WHERE day = ? ORDER BY id DESC LIMIT 1').get(day);
  return row === undefined ? nationalHoliday(day) !== undefined : row['quiet'] === 1;
}

/** Mark a day closed (`quiet` true) or withdraw that mark (false). Append-only: every mark and withdrawal is kept. */
export function markQuietDay(db: StampStore, day: string, quiet: boolean, reason: string, by: string, nowMs: number): void {
  daysBetween(day, day);
  if (reason.trim() === '') throw new Error('give the reason');
  db.prepare('INSERT INTO quiet_days (day, quiet, reason, by, at) VALUES (?, ?, ?, ?, ?)').run(
    day,
    quiet ? 1 : 0,
    reason.trim(),
    by,
    isoOf(nowMs),
  );
}
