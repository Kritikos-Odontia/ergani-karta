// SPDX-License-Identifier: EUPL-1.2
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertOutsideCodeFolders } from '../code-folders.js';
import type { ErganiRealm } from '../config.js';
import { athensDate, type ReadClient } from '../ergani/exbase.js';
import { monthComparison } from '../export/model.js';
import { comparisonPage } from '../export/render.js';
import type { Heartbeat } from '../heartbeat.js';
import { RealmMismatchError, describePull, pullMonth, type PullReport } from './pull.js';
import { EmployerMismatchError, recordEmployer } from './store.js';
import type { ArchiveRun } from './status.js';

/**
 * THE DAILY ARCHIVE RUN — READ ONLY: it reads work-card stamps and schedule out of ΕΡΓΑΝΗ and keeps them. It files
 * nothing. Run once a day (`ergani archive`, 03:15 Athens by default) by the archive container (docs/INSTALL.md).
 *
 * ── WHAT IT READS, AND WHEN ──────────────────────────────────────────────────────────────────────
 * Every month ΕΡΓΑΝΗ still holds and the archive still reads — one to five months back (it refuses six and more:
 * docs/DECISIONS.md, «Never read a month ΕΡΓΑΝΗ may have deleted»), from `archiveFrom` on — for EVERY branch, each with
 * its own login. A month is pulled for a branch whenever the record holds no complete pull of it begun in the last
 * `REREAD_DAYS` days. That one rule gives:
 *   · last month from the 1st, and again every day until it completes — and a month still failing when the calendar
 *     turns is still asked, as long as ΕΡΓΑΝΗ holds it;
 *   · every held month one to FOUR back again each week, because a month changes after it ends: a late card filing is
 *     a re-filing («the most recent declaration is valid»), and the accountant re-declares afterwards (pull.ts). A
 *     re-pull stores what changed and keeps what was.
 *     ⛔ FIVE back, a month is pulled only if it was never held complete: its first days are then near ΕΡΓΑΝΗ's six
 *     months, and what it answers for a day it has deleted is unmeasured — an empty day would read as «no stamp» and
 *     mark every stamp held for it «no longer answered». A catch-up of a month never read is worth that risk; a
 *     routine re-read is not.
 * Every run writes every month's comparison page again, from the record: a page never lags a pull, and a page that
 * failed to be written is written the next day.
 *
 * ── WHEN THE MONITOR IS TOLD — a missed heartbeat IS the alarm ───────────────────────────────────
 *   · «up» only when every pull this run asked for completed, and every month in the window is held complete for every
 *     branch, with its page;
 *   · «down» when last month's latest complete pull of a branch answered NO stamp at all while its schedule, in the
 *     same answer, declares working hours: nobody stamped, or ΕΡΓΑΝΗ answered something this reader takes for an empty
 *     day. Either needs a human while ΕΡΓΑΝΗ still holds the month.
 *     ⚠ KNOWN LIMIT, kept on purpose: ΕΡΓΑΝΗ answers a person on leave with the leave row AND their ordinary «ΕΡΓ»
 *     hours, and this check counts those hours. So a month when the whole carded staff of a branch was on declared
 *     leave also shows «down» for the following month, although nobody had to stamp. A false «down» is the safe
 *     direction — it is never a false «up», and it touches no data. The comparison page reads the leave rightly;
 *   · nothing, when anything failed — the heartbeat stops, and the monitor turns red.
 * ⚠ A month that leaves the window never complete is lost to the record; the monitor was red for it for four months
 * first.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────────────────────────
 * It never creates the record: that is done once at install (`ergani pull --init-store`). A missing record is a failure
 * here, never a reason to start a second, empty one. It never deletes anything.
 */

/** A held month is read again once its latest complete pull is this old. */
export const REREAD_DAYS = 7;

export interface DailyOptions {
  /** Opens the EXISTING record store for this run (closed again after it). */
  openStore: () => DatabaseSync;
  /** One read client per branch, each with that branch's own login. */
  clients: readonly ReadClient[];
  /** The branches that declare no standing schedule (`STAMP_BRANCH_<n>_SCHEDULE=none`, pull.ts). */
  noStandingSchedule?: ReadonlySet<string>;
  realm: ErganiRealm;
  employerAfm: string;
  /** `YYYY-MM` — the first month the archive keeps. */
  archiveFrom: string;
  /** Where the comparison pages are written. ⛔ Never inside a code folder. */
  exportsDir: string;
  now: () => number;
  /** The monitor (heartbeat.ts). Unset: the log only. */
  beat?: Heartbeat | undefined;
  log: (line: string) => void;
  /** Desktop status, persisted beside the record; operational shapes only, no ministry prose. */
  status?: (outcome: ArchiveRun) => void;
}

export type DailyOutcome = ArchiveRun & { message: string };

/** One daily run. Never throws for a failed read or page: that is a `failed` outcome, and the monitor hears nothing. */
export async function runDailyArchive(o: DailyOptions): Promise<DailyOutcome> {
  try { return await dailyRun(o); }
  catch (error) {
    o.status?.({ kind: 'failed' });
    throw error;
  }
}

async function dailyRun(o: DailyOptions): Promise<DailyOutcome> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.archiveFrom)) throw new Error('ARCHIVE_FROM must be the first month the archive keeps, YYYY-MM.');
  const thisMonth = athensDate(o.now()).slice(0, 7);
  const months = [5, 4, 3, 2, 1].map((back) => monthsBefore(thisMonth, back)).filter((m) => m >= o.archiveFrom);
  const oldest = monthsBefore(thisMonth, 5);
  const last = monthsBefore(thisMonth, 1);
  // ⓘ Opened first: a missing record fails the run before anything is read or told, even while waiting.
  const db = o.openStore();
  try {
    // ⛔ This record's employer and realm, asked first — before a month «held recently» is skipped or a page is written.
    // A pull asks too, but a run that pulls nothing would otherwise write another employer's (or the trial's) pages
    // and tell the monitor «up».
    if ((recordEmployer(db) ?? o.employerAfm) !== o.employerAfm) throw new EmployerMismatchError();
    const otherRealms = db.prepare('SELECT DISTINCT realm FROM pulls WHERE realm <> ? ORDER BY realm').all(o.realm);
    if (otherRealms.length > 0) throw new RealmMismatchError(o.realm, otherRealms.map((r) => String(r['realm'])));
    if (months.length === 0) return await tell(o, { kind: 'up', waiting: true, message: `waiting — the archive starts with ${o.archiveFrom}` });
    const failed: string[] = [];
    const incomplete: Array<{ month: string; branch: string }> = [];
    const pages: string[] = [];
    for (const month of months) {
      for (const client of o.clients) {
        const branch = client.branchCode;
        if (heldRecently(db, month, branch, month === oldest ? undefined : o.now() - REREAD_DAYS * 86_400_000)) continue;
        o.log(`pulling ${month}, branch ${branch}`);
        let report: PullReport;
        try {
          report = await pullMonth(db, client, {
            realm: o.realm,
            employerAfm: o.employerAfm,
            month,
            noStandingSchedule: o.noStandingSchedule?.has(branch) === true,
          });
        } catch (error) {
          failed.push(`${month} (branch ${branch}: ${error instanceof Error ? error.message : String(error)})`);
          incomplete.push({ month, branch });
          continue;
        }
        for (const line of describePull(report)) o.log(line);
        if (report.outcome !== 'complete') { failed.push(`${month} (branch ${branch})`); incomplete.push({ month, branch }); }
      }
      try {
        writePage(o.exportsDir, `sygkrisi-${month}.html`, comparisonPage(monthComparison(db, month), o.now()));
      } catch (error) {
        failed.push(`${month} (its page: ${error instanceof Error ? error.name : 'error'})`);
        pages.push(month);
      }
    }
    if (failed.length > 0) {
      return await tell(o, { kind: 'failed', incomplete, pages, message: `not complete: ${failed.join(', ')} — asked again tomorrow; the monitor stays red until every month is held` });
    }

    // What ΕΡΓΑΝΗ answered for last month in each branch's LATEST complete pull — never every row the record ever held:
    // a withdrawn stamp or a re-declared day off is the month as it stands now.
    let stamps = 0;
    for (const client of o.clients) {
      const { stampRows, declaredHours } = lastAnswer(db, last, client.branchCode);
      stamps += stampRows;
      if (stampRows === 0 && declaredHours > 0) {
        return await tell(o, {
          kind: 'down',
          incomplete: [{ month: last, branch: client.branchCode }],
          message:
            `${last} held with NO stamp for branch ${client.branchCode}, while its schedule declares working hours — nobody ` +
            'stamped, or ΕΡΓΑΝΗ answered something unrecognised. Check it while ΕΡΓΑΝΗ still holds the month.',
        });
      }
    }
    return await tell(o, { kind: 'up', message: `${last} held — ${stamps} stamp rows; ${months.length} month(s) held` });
  } finally {
    db.close();
  }
}

/** Log the outcome, and tell the monitor — «up» or «down»; never anything for a failed run. */
async function tell(o: DailyOptions, outcome: DailyOutcome): Promise<DailyOutcome> {
  o.status?.(outcome);
  o.log(`${outcome.kind} — ${outcome.message}`);
  if (outcome.kind !== 'failed' && o.beat !== undefined) {
    try {
      await o.beat(outcome.kind, outcome.message);
    } catch (error) {
      // The monitor did not hear it: it turns red by itself, which is the right signal.
      o.log(`heartbeat: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
  return outcome;
}

/** A complete pull of `month` for `branch`, begun after `sinceMs` — or ever, when `sinceMs` is undefined. */
function heldRecently(db: DatabaseSync, month: string, branch: string, sinceMs: number | undefined): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM pulls WHERE month = ? AND branch = ? AND outcome = 'complete' AND (? IS NULL OR started_at > ?) LIMIT 1`,
    )
    .get(month, branch, ...Array(2).fill(sinceMs === undefined ? null : new Date(sinceMs).toISOString()));
  return row !== undefined;
}

/** In `branch`'s latest complete pull of `month`: how many stamp rows it answered, and how many schedule rows with hours. */
function lastAnswer(db: DatabaseSync, month: string, branch: string): { stampRows: number; declaredHours: number } {
  const latest = db
    .prepare("SELECT max(id) AS id FROM pulls WHERE month = ? AND branch = ? AND outcome = 'complete'")
    .get(month, branch)?.['id'];
  if (latest === null || latest === undefined) return { stampRows: 0, declaredHours: 0 };
  const stampRows = Number(db.prepare('SELECT count(*) AS n FROM stamp_sightings WHERE pull_id = ?').get(latest)?.['n']);
  const declaredHours = Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM schedule_sightings g JOIN schedule s ON s.id = g.schedule_id
         WHERE g.pull_id = ? AND s.hour_from <> ''`,
      )
      .get(latest)?.['n'],
  );
  return { stampRows, declaredHours };
}

function writePage(dir: string, name: string, html: string): void {
  assertOutsideCodeFolders(dir, 'The exports folder');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), html, { encoding: 'utf8', mode: 0o600 });
}

/** `YYYY-MM` minus `back` months. */
export function monthsBefore(month: string, back: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, index - 1 - back, 1)).toISOString().slice(0, 7);
}

/**
 * The instant of the next `at` (`HH:MM`, Athens) strictly after `nowMs`. ⓘ Found by stepping through the next two
 * calendar days in Athens, so the summer/winter change is honoured.
 */
export function nextRunAfter(nowMs: number, at: string, athensInstant: (date: string, time: string) => number): number {
  const today = athensDate(nowMs);
  for (let add = 0; add <= 2; add += 1) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) + add * 86_400_000).toISOString().slice(0, 10);
    const when = athensInstant(day, at);
    if (when > nowMs) return when;
  }
  throw new Error('no next run found');
}
