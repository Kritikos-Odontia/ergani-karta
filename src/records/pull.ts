// SPDX-License-Identifier: EUPL-1.2
import type { DatabaseSync } from 'node:sqlite';
import type { ErganiRealm } from '../config.js';
import {
  SCHEDULE_SERVICE,
  STAMPS_SERVICE,
  UnrecognisedAnswerError,
  assertReadableDate,
  athensDate,
  pararthmaAaOf,
  readSchedule,
  readStamps,
  type ReadClient,
} from '../ergani/exbase.js';
import type { ScheduleRow, StampRow } from '../ergani/types.js';
import { EmployerMismatchError, claimRecordStore, inTransaction, recordEmployer, type PullLogEntry } from './store.js';

/**
 * THE MONTHLY PULL — one month of `EX_BASE_07` (the stamps) and `EX_BASE_08` (the declared schedule),
 * read day by day out of ΕΡΓΑΝΗ for ONE branch, and written into the employer's record store. An employer with
 * several branches pulls each with its own branch's login (records/cli.ts, records/daily.ts), into the one store.
 *
 * ── ⛔ IT CANNOT WRITE TO ΕΡΓΑΝΗ ──────────────────────────────────────────────────────────────────
 * It takes a `ReadClient` (ergani/exbase.ts), which has no filing method. It reads; it never files.
 *
 * ── ⭐ A RE-PULL CORRECTS; IT NEVER DUPLICATES, AND IT NEVER DROPS ─────────────────────────────────
 * ΕΡΓΑΝΗ is the source of truth and a month can legitimately change after the fact: under απολογιστικό
 * the accountant re-declares rest days and overtime afterwards, so a month read in December may differ
 * from the same month read in November. Re-pulling is therefore safe and expected:
 *   · a row already held is not stored again — the pull records that it saw it (a sighting);
 *   · a row the ministry has changed arrives as a new row; the old one stays;
 *   · ⛔ a row the ministry no longer answers is KEPT, and counted in the log as no longer answered.
 *     A row that vanishes from ΕΡΓΑΝΗ is a finding, not a tidy-up.
 *
 * ── HOW A READ THAT FAILS IS RECORDED ─────────────────────────────────────────────────────────────
 * Every read's outcome is logged per service per day: a row count, or the error exactly as raised.
 *   · An answer the reader does not recognise (`UnrecognisedAnswerError`) is that ONE day's problem — ΕΡΓΑΝΗ
 *     answered, the reader could not read it — so the walk goes on and the pull ends `incomplete`.
 *   · Any other failure (network, sign-in, a refusal, a 429, a service not offered to this user) STOPS
 *     THAT SERVICE's walk, rather than asking thirty more times, and the pull ends `stopped`. Nothing is
 *     retried: the job may run days late, and re-running it is the retry.
 *     ⚠ The OTHER service's walk goes on. Entitlement is per service and per user (docs/RULES.md: never
 *     assume a service is available), and the stamps are the record the law requires: a user refused
 *     the schedule must still archive every day's stamps. When the failure is the conversation itself,
 *     the other service's next read fails too and the walk ends — one request later, not sixty.
 *   · Days read before the failure are kept. ⚠ A day whose read failed says nothing about the rows held
 *     for it: they are never counted as no longer answered.
 * The network walk happens first and the store is written once, in one transaction: the pull is logged
 * with all it read, or — if the write itself fails — not at all.
 *
 * ── ⛔ WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
 * No scheduler, no health check, no alarm. The data is up to a month old by construction, so a same-day
 * alarm cannot be built on it and must not be faked; and a monthly job that runs days late breaks
 * nothing. The daily scheduler around it is records/daily.ts.
 */

export type PullOutcome = PullLogEntry['outcome'];

/** A read of one service for one day that did not produce rows, and why — the message as raised. */
export interface FailedRead {
  service: typeof STAMPS_SERVICE | typeof SCHEDULE_SERVICE;
  day: string;
  error: string;
}

/** What one pull did: its log entry, plus the reads that failed. */
export interface PullReport extends PullLogEntry {
  /** Every day of the month, per service, that was not read — in the order tried. */
  failedReads: FailedRead[];
  /** The failed reads that stopped a service's walk — at most one per service; empty unless `stopped`. */
  stops: FailedRead[];
  /** How many (service, day) reads the month needs: two per calendar day. */
  readsNeeded: number;
  /** How many were tried before the walk ended — fewer than `readsNeeded` only when it stopped. */
  readsAttempted: number;
}

type DayRead =
  | { service: typeof STAMPS_SERVICE; day: string; rows: StampRow[] }
  | { service: typeof SCHEDULE_SERVICE; day: string; rows: ScheduleRow[] }
  | FailedRead;

export interface PullOptions {
  /** Which ΕΡΓΑΝΗ `client` reads — `config.erganiRealm`. The store accepts pulls from one realm only. */
  realm: ErganiRealm;
  /** The employer whose login `client` is. The store holds one employer's record only (records/store.ts). */
  employerAfm: string;
  /**
   * The employer has said this branch declares no standing schedule (`STAMP_BRANCH_<n>_SCHEDULE=none`): ΕΡΓΑΝΗ's
   * bare `null` for its EX_BASE_08 is then a day with no declared rows (exbase.ts `readSchedule`), not an answer the
   * reader does not recognise — which would leave every month of that branch incomplete, for good.
   */
  noStandingSchedule?: boolean | undefined;
  /** `YYYY-MM`. Default: the month before today in Athens, by the client's clock. */
  month?: string | undefined;
}

/** The store already holds pulls from another ΕΡΓΑΝΗ realm. Nothing was sent. */
export class RealmMismatchError extends Error {
  constructor(realm: ErganiRealm, held: readonly string[]) {
    super(
      `Not pulled: this record store holds pulls from ${held.join(', ')}, and this client reads ${realm}. ` +
        'One store holds one realm — trial answers («ΑΚΥΡΟ») mixed into the real record would stand beside ' +
        'real stamps and make every real row read as no longer answered. Check ERGANI_ENV and ERGANI_RECORDS_DB.',
    );
    this.name = 'RealmMismatchError';
  }
}

/** How many months ΕΡΓΑΝΗ keeps card data (docs/RULES.md, rule 2). */
export const RETENTION_MONTHS = 6;

/** A month ΕΡΓΑΝΗ may already have partly deleted. Nothing was sent. */
export class PastRetentionError extends Error {
  constructor(month: string) {
    super(
      `Not pulled: ${month} is ${RETENTION_MONTHS} or more months back. ΕΡΓΑΝΗ keeps card data ` +
        `${RETENTION_MONTHS} months, so some of its days may already be deleted, and what ΕΡΓΑΝΗ answers for a ` +
        'deleted day has not been measured: an empty answer would be recorded as «no stamp» on a day someone ' +
        'worked, or mark every stamp held for it «no longer answered» — for good. Days never read stay «not read».',
    );
    this.name = 'PastRetentionError';
  }
}

/**
 * Pull one month into `db`. Refused before anything is sent or logged — a refused request is not a pull:
 *   · ⛔ a month ΕΡΓΑΝΗ cannot answer yet, this month or later — the reader's `OutOfWindowError`;
 *   · ⛔ a month `RETENTION_MONTHS` or more before this Athens month, pulled before or not —
 *     `PastRetentionError`. It is the first month whose earliest day can be past ΕΡΓΑΝΗ's six, and an
 *     empty answer for a deleted day would stand as a false «no stamp», or flip what is held, for good.
 *     By design (docs/DECISIONS.md, «Never read a month ΕΡΓΑΝΗ may have deleted»): the monthly pull has five
 *     months of slack, and a month left for longer is one ΕΡΓΑΝΗ has largely deleted anyway;
 *   · ⛔ a realm or an employer other than the one the store already holds — `RealmMismatchError`,
 *     `EmployerMismatchError` — asked again inside the write, because another pull may have been written
 *     while this one walked.
 * ⓘ A store holds every branch of its employer. A day counts as read (export/model.ts) only once every branch the
 * store holds has read it — so a branch added later shows its earlier months as «not read», which is true.
 */
export async function pullMonth(db: DatabaseSync, client: ReadClient, options: PullOptions): Promise<PullReport> {
  const today = athensDate(client.now());
  const asked = options.month ?? previousMonth(today);
  const days = daysOf(asked);
  // The whole month shares its first day's fate: if the 1st is readable, so is the 31st.
  assertReadableDate(days[0] as string, today);
  if (monthIndex(today) - monthIndex(asked) >= RETENTION_MONTHS) throw new PastRetentionError(asked);
  const realm = options.realm;
  const branch = pararthmaAaOf(client.branchCode);
  assertOneSource(db, realm, options.employerAfm, undefined);
  const startedAt = new Date(client.now()).toISOString();

  const reads: DayRead[] = [];
  const stops: FailedRead[] = [];
  walk: for (const day of days) {
    for (const service of [STAMPS_SERVICE, SCHEDULE_SERVICE] as const) {
      if (stops.some((stop) => stop.service === service)) continue;
      try {
        if (service === STAMPS_SERVICE) reads.push({ service, day, rows: await readStamps(client, day) });
        else reads.push({ service, day, rows: await readSchedule(client, day, { noStandingSchedule: options.noStandingSchedule === true }) });
      } catch (error) {
        const failed: FailedRead = { service, day, error: error instanceof Error ? error.message : String(error) };
        reads.push(failed);
        if (!(error instanceof UnrecognisedAnswerError)) {
          stops.push(failed);
          if (stops.length === 2) break walk;
        }
      }
    }
  }

  const failedReads = reads.filter((r): r is FailedRead => 'error' in r);
  const readsNeeded = days.length * 2;
  const outcome: PullOutcome = stops.length > 0 ? 'stopped' : failedReads.length > 0 ? 'incomplete' : 'complete';
  const finishedAt = new Date(client.now()).toISOString();
  const entry = inTransaction(db, () => {
    assertOneSource(db, realm, options.employerAfm, startedAt);
    return record(db, { month: asked, realm, branch, startedAt, finishedAt, outcome }, reads);
  });
  return { ...entry, failedReads, stops, readsNeeded, readsAttempted: reads.length };
}

/**
 * ⛔ One store holds one realm and one employer — every branch of it. The employer is recorded with the store
 * (`claimRecordStore`), because a read carries none: the signed-in user decides whose rows answer.
 * `claimAt` undefined: only check, write nothing (before the walk); an instant: record a new store's employer then
 * (inside the write).
 */
function assertOneSource(db: DatabaseSync, realm: ErganiRealm, employerAfm: string, claimAt: string | undefined): void {
  if (claimAt !== undefined) claimRecordStore(db, employerAfm, claimAt);
  else if ((recordEmployer(db) ?? employerAfm) !== employerAfm) throw new EmployerMismatchError();
  const otherRealms = db.prepare('SELECT DISTINCT realm FROM pulls WHERE realm <> ? ORDER BY realm').all(realm);
  if (otherRealms.length > 0) {
    throw new RealmMismatchError(realm, otherRealms.map((r) => String(r['realm'])));
  }
}


/** `YYYY-MM…` as a count of months, so two can be subtracted. */
function monthIndex(text: string): number {
  return Number(text.slice(0, 4)) * 12 + Number(text.slice(5, 7));
}

/** The month before the one `today` (`YYYY-MM-DD`) falls in, as `YYYY-MM`. */
export function previousMonth(today: string): string {
  const [year, month] = today.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

/** Every calendar day of `month` (`YYYY-MM`), as `YYYY-MM-DD`, in order. */
export function daysOf(month: string): string[] {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (m === null) throw new RangeError('month must be written YYYY-MM');
  const [year, index] = [Number(m[1]), Number(m[2])];
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Writing a pull into the record
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How one kind of row maps onto its table. `columns` are the row's content, in the order of the table's
 * UNIQUE constraint after `branch, day`; `values` reads them off a parsed row. The flag is stored 0/1.
 */
interface RowTable<Row> {
  table: 'stamps' | 'schedule';
  sightings: 'stamp_sightings' | 'schedule_sightings';
  sightingKey: 'stamp_id' | 'schedule_id';
  columns: readonly string[];
  values: (row: Row) => Array<string | number>;
}

const STAMP_TABLE: RowTable<StampRow> = {
  table: 'stamps',
  sightings: 'stamp_sightings',
  sightingKey: 'stamp_id',
  columns: ['afm', 'date', 'hour_from', 'hour_to', 'ends_next_day'],
  values: (r) => [r.Afm, r.Date, r.HourFrom, r.HourTo, r.IsEndDateDifferentThanDate ? 1 : 0],
};

const SCHEDULE_TABLE: RowTable<ScheduleRow> = {
  table: 'schedule',
  sightings: 'schedule_sightings',
  sightingKey: 'schedule_id',
  columns: ['afm', 'type', 'hour_from', 'hour_to', 'break_minutes', 'break_in_work', 'extra'],
  values: (r) => [r.Afm, r.Type, r.HourFrom, r.HourTo, r.BreakMinutes, r.BreakInWork, r.Extra],
};

interface Tally {
  rows: number;
  added: number;
  noLongerAnswered: number;
}

interface PullHeader {
  month: string;
  realm: ErganiRealm;
  branch: string;
  startedAt: string;
  finishedAt: string;
  outcome: PullOutcome;
}

/**
 * Write one pull: its log row, what each read answered, and each row — stored once, sighted by every
 * pull that reads it. Runs inside the caller's transaction.
 */
function record(db: DatabaseSync, header: PullHeader, reads: readonly DayRead[]): PullLogEntry {
  // First, from what is already held, what this pull adds and what it no longer finds — the log row
  // carries both counts and is written before the rows that point at it.
  const plans = reads.map((read) =>
    'error' in read
      ? undefined
      : read.service === STAMPS_SERVICE
        ? plan(db, STAMP_TABLE, header.branch, read.day, read.rows)
        : plan(db, SCHEDULE_TABLE, header.branch, read.day, read.rows),
  );
  const tally = (service: string): Tally =>
    plans.reduce<Tally>(
      (sum, p, i) =>
        p === undefined || reads[i]?.service !== service
          ? sum
          : { rows: sum.rows + p.rows, added: sum.added + p.added, noLongerAnswered: sum.noLongerAnswered + p.noLongerAnswered },
      { rows: 0, added: 0, noLongerAnswered: 0 },
    );
  const stamps = tally(STAMPS_SERVICE);
  const schedule = tally(SCHEDULE_SERVICE);

  const inserted = db
    .prepare(
      `INSERT INTO pulls (month, realm, branch, started_at, finished_at, outcome, stamp_rows, schedule_rows,
         new_stamp_rows, new_schedule_rows, stamps_no_longer_answered, schedule_no_longer_answered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      header.month,
      header.realm,
      header.branch,
      header.startedAt,
      header.finishedAt,
      header.outcome,
      stamps.rows,
      schedule.rows,
      stamps.added,
      schedule.added,
      stamps.noLongerAnswered,
      schedule.noLongerAnswered,
    );
  const pullId = Number(inserted.lastInsertRowid);

  const logRead = db.prepare('INSERT INTO day_reads (pull_id, service, day, rows, error) VALUES (?, ?, ?, ?, ?)');
  reads.forEach((read, i) => {
    if ('error' in read) logRead.run(pullId, read.service, read.day, null, read.error);
    else logRead.run(pullId, read.service, read.day, read.rows.length, null);
    plans[i]?.write(pullId);
  });

  return {
    id: pullId,
    ...header,
    stampRows: stamps.rows,
    scheduleRows: schedule.rows,
    newStampRows: stamps.added,
    newScheduleRows: schedule.added,
    stampsNoLongerAnswered: stamps.noLongerAnswered,
    scheduleNoLongerAnswered: schedule.noLongerAnswered,
  };
}

/**
 * One successful read of one day, matched against what the record already holds for that branch and
 * day. Identical rows within one answer are ONE row sighted with `copies` > 1 — never silently merged
 * into one listing. `write` stores the new rows and sights every row of the answer.
 */
function plan<Row>(db: DatabaseSync, t: RowTable<Row>, branch: string, day: string, rows: readonly Row[]) {
  const keyOf = (values: ReadonlyArray<string | number | null>) => JSON.stringify(values);
  const held = new Map<string, number>();
  const heldRows = db
    .prepare(`SELECT id, ${t.columns.join(', ')} FROM ${t.table} WHERE branch = ? AND day = ?`)
    .all(branch, day) as Array<Record<string, string | number>>;
  for (const row of heldRows) held.set(keyOf(t.columns.map((c) => row[c] ?? null)), Number(row['id']));

  const answer = new Map<string, { values: Array<string | number>; copies: number }>();
  for (const row of rows) {
    const values = t.values(row);
    const key = keyOf(values);
    const seen = answer.get(key);
    if (seen === undefined) answer.set(key, { values, copies: 1 });
    else seen.copies += 1;
  }

  return {
    rows: rows.length,
    added: [...answer.keys()].filter((key) => !held.has(key)).length,
    noLongerAnswered: [...held.keys()].filter((key) => !answer.has(key)).length,
    write(pullId: number): void {
      const insert = db.prepare(
        `INSERT INTO ${t.table} (branch, day, ${t.columns.join(', ')}, first_pull_id)
         VALUES (?, ?, ${t.columns.map(() => '?').join(', ')}, ?)`,
      );
      const sight = db.prepare(`INSERT INTO ${t.sightings} (${t.sightingKey}, pull_id, copies) VALUES (?, ?, ?)`);
      for (const [key, { values, copies }] of answer) {
        const id = held.get(key) ?? Number(insert.run(branch, day, ...values, pullId).lastInsertRowid);
        sight.run(id, pullId, copies);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Saying what happened, in plain words
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A pull described for the person who runs it. ⛔ Counts, days and error messages only — never an
 * ΑΦΜ or an hour: nothing about a named person goes into a log line.
 */
export function describePull(report: PullReport): string[] {
  const lines = [
    `Pull #${report.id} of ${report.month} (${report.realm}, branch ${report.branch}): ${report.outcome.toUpperCase()}.`,
    `  EX_BASE_07 stamps:   ${report.stampRows} row(s) answered, ${report.newStampRows} new to the record, ` +
      `${report.stampsNoLongerAnswered} held but no longer answered.`,
    `  EX_BASE_08 schedule: ${report.scheduleRows} row(s) answered, ${report.newScheduleRows} new to the record, ` +
      `${report.scheduleNoLongerAnswered} held but no longer answered.`,
  ];
  if (report.outcome === 'complete' && report.stampRows === 0) {
    lines.push(
      `⚠ ΕΡΓΑΝΗ answered ZERO stamp rows for the whole of ${report.month}. Every day was read and none held ` +
        'a stamp. If staff worked that month, that is a finding — check it; it is not a quiet month.',
    );
  }
  if (report.stampsNoLongerAnswered + report.scheduleNoLongerAnswered > 0) {
    lines.push(
      '⚠ Some rows the record holds are no longer in ΕΡΓΑΝΗ’s answer for their day — changed or withdrawn ' +
        'upstream. They are kept, beside what ΕΡΓΑΝΗ now says.',
    );
  }
  for (const f of report.failedReads) {
    if (!report.stops.includes(f)) lines.push(`⚠ ${f.service} for ${f.day} was not read: ${f.error}`);
  }
  for (const stop of report.stops) lines.push(`⚠ Reading STOPPED at ${stop.service} for ${stop.day}: ${stop.error}`);
  if (report.stops.length === 1) {
    const other = report.stops[0]?.service === STAMPS_SERVICE ? SCHEDULE_SERVICE : STAMPS_SERVICE;
    lines.push(`  ${other} was not stopped by it: it went on to the end of the month.`);
  }
  if (report.stops.length > 0) {
    lines.push(
      `  ${report.readsNeeded - report.readsAttempted} of ${report.readsNeeded} reads were not attempted. Days ` +
        'read before the stop are kept. Run the pull again once the cause is cleared; a re-pull never duplicates.',
    );
  }
  return lines;
}
