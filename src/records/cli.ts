// SPDX-License-Identifier: EUPL-1.2
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { branchOf, isValidAfm, loadEmployerConfig } from '../config.js';
import { ErganiClient } from '../ergani/client.js';
import { assertOutsideCodeFolders } from '../code-folders.js';
import { heartbeatSender } from '../heartbeat.js';
import { athensInstant } from '../stamp/athens.js';
import { heartbeatUrlOf, loadBranchSettings } from '../stamp/config.js';
import { nextRunAfter, runDailyArchive } from './daily.js';
import { describePull, pullMonth } from './pull.js';
import { claimRecordStore, openRecordStore } from './store.js';

/**
 * THE MONTHLY ARCHIVE, from the command line — READ ONLY, files nothing.
 *
 *   ergani pull --init-store                        create the empty record, once (needs only ERGANI_EMPLOYER_AFM)
 *   ergani pull [--month YYYY-MM] [--branch N]      read one month (default: last month), every branch or one
 *   ergani archive [--once] [--at HH:MM]            the daily run (records/daily.ts): at start if the last was missed, then every day at 03:15
 *
 * The record store is `ERGANI_RECORDS_DB` (an absolute path). `pull` reads EX_BASE_07 and EX_BASE_08 for each branch
 * with that branch's own login, into the one store, and says what it found; it exits 0 only when every day was read.
 */

export interface PullCommand {
  /** The record store's path — `ERGANI_RECORDS_DB`. */
  store: string;
  month: string | undefined;
  /** One branch, or `undefined` for every branch. */
  branch: string | undefined;
  /**
   * `--init-store`: create the empty store and stop — no month read, no login needed, nothing sent. For an install
   * that must hold the record's file before the first month is readable, so the daily run never creates one, and a
   * store that later goes missing fails loudly instead of quietly starting a second, empty record.
   */
  init: boolean;
}

/**
 * The record store's path, checked before anything is opened or sent. Two rules keep the five-year record in ONE file:
 *   · it must be absolute — a relative path depends on where the command happens to be run from;
 *   · ⛔ it must lead outside every code folder — the store holds ΑΦΜ and working hours.
 * ⓘ Errors name the variable, never its value.
 */
export function recordsPath(env: NodeJS.ProcessEnv): string {
  const store = env['ERGANI_RECORDS_DB'];
  if (store === undefined || store === '') {
    throw new Error('ERGANI_RECORDS_DB is not set — it is the path of the record store file.');
  }
  if (!isAbsolute(store)) {
    throw new Error(
      'ERGANI_RECORDS_DB must be an absolute path: a relative one depends on where the command is run from, ' +
        'and a second file is a split record.',
    );
  }
  assertOutsideCodeFolders(store, 'ERGANI_RECORDS_DB');
  return store;
}

/**
 * The branches the employer says declare no standing schedule (`STAMP_BRANCH_<n>_SCHEDULE=none`), read from the same
 * settings as the page, so the page and the archive never disagree on which branch has one.
 */
export function noStandingScheduleOf(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set(loadBranchSettings(env).filter((b) => !b.scheduleFromErgani).map((b) => b.code));
}

/**
 * The `pull` command line and environment. ⛔ The store must already exist — so a mistyped path fails here instead of
 * quietly starting a second, empty record beside the real one — except for `--init-store`, which creates it.
 */
export function pullCommand(argv: readonly string[], env: NodeJS.ProcessEnv): PullCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      month: { type: 'string' },
      branch: { type: 'string' },
      'init-store': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const store = recordsPath(env);
  if (values['init-store'] === true) {
    if (values.month !== undefined || values.branch !== undefined) {
      throw new Error('--init-store creates the empty store and reads nothing: it takes neither --month nor --branch.');
    }
    if (existsSync(store)) {
      throw new Error('There is already a file at ERGANI_RECORDS_DB — --init-store creates a store, it never touches one.');
    }
    return { store, month: undefined, branch: undefined, init: true };
  }
  if (!existsSync(store)) {
    throw new Error(
      'There is no record store at ERGANI_RECORDS_DB. Create it once with --init-store; otherwise the path is wrong.',
    );
  }
  return { store, month: values.month, branch: values.branch, init: false };
}

export async function runPull(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const command = pullCommand(argv, env);
  if (command.init) {
    const afm = env['ERGANI_EMPLOYER_AFM'] ?? '';
    if (!isValidAfm(afm)) throw new Error('ERGANI_EMPLOYER_AFM must be the employer\'s ΑΦΜ: the record is created for it.');
    const db = openRecordStore(command.store);
    try {
      claimRecordStore(db, afm, new Date().toISOString());
    } finally {
      db.close();
    }
    out('ΕΡΓΑΝΗ record store created, empty, for this employer — no month read, nothing sent.');
    return 0;
  }
  const employer = loadEmployerConfig(env);
  const branches = command.branch === undefined ? employer.branches : [branchOf(employer, command.branch)];
  const noStandingSchedule = noStandingScheduleOf(env);
  const db = openRecordStore(command.store);
  try {
    out('ΕΡΓΑΝΗ monthly pull — READ ONLY, files nothing');
    out(`  realm    : ${employer.erganiRealm}${employer.erganiRealm === 'production' ? '  (the real register)' : ''}`);
    out('');
    let complete = true;
    for (const config of branches) {
      const report = await pullMonth(db, new ErganiClient(config), {
        realm: employer.erganiRealm,
        employerAfm: employer.employerAfm,
        month: command.month,
        noStandingSchedule: noStandingSchedule.has(config.branchCode),
      });
      for (const line of describePull(report)) out(line);
      complete &&= report.outcome === 'complete';
    }
    return complete ? 0 : 1;
  } finally {
    db.close();
  }
}

/** Where each daily run's start is noted: beside the record, holding one instant and nothing else. */
const lastRunPath = (store: string) => `${store}.last-run`;

/** Note that a daily run starts now (whatever it then reads, or fails to). */
export function markArchiveRun(store: string, nowMs: number): void {
  writeFileSync(lastRunPath(store), `${new Date(nowMs).toISOString()}\n`, { mode: 0o600 });
}

/**
 * Whether the daily run is due when the archive starts: only when no run began in the last day — the last 03:15 run
 * was missed. Judged on the runs themselves, not on the pulls: a run that found every month held reads nothing and
 * leaves no pull behind, and a restart later that day must still not begin a month's reads with the branch logins the
 * outbox is filing with, sharing their rate limit inside the 15 minutes. ⓘ No note, or one that cannot be read: due.
 */
export function dueAtStart(store: string, nowMs: number): boolean {
  let last: number;
  try {
    last = Date.parse(readFileSync(lastRunPath(store), 'utf8').trim());
  } catch {
    return true;
  }
  return Number.isNaN(last) || nowMs - last >= 86_400_000;
}

/**
 * `ergani archive` — the daily run (records/daily.ts), at start when the last one was missed (`dueAtStart`), then every
 * day at `--at` (03:15 Athens by default), for as long as the container runs; `--once` runs it once and exits (0 for
 * «up», 1 otherwise).
 *   ARCHIVE_FROM=YYYY-MM          the first month the archive keeps (required)
 *   ARCHIVE_HEARTBEAT_URL=…       the monitor's push URL (optional; heartbeat.ts)
 *   ERGANI_EXPORTS_DIR=…          where the comparison pages go (default: `exports/` beside the record)
 */
export async function runArchive(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { once: { type: 'boolean', default: false }, at: { type: 'string', default: '03:15' } },
    strict: true,
    allowPositionals: false,
  });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.at)) throw new Error('--at is HH:MM, Athens time.');
  const store = recordsPath(env);
  const employer = loadEmployerConfig(env);
  const exportsDir = env['ERGANI_EXPORTS_DIR']?.trim() || join(dirname(store), 'exports');
  if (!isAbsolute(exportsDir)) throw new Error('ERGANI_EXPORTS_DIR must be an absolute path.');
  assertOutsideCodeFolders(exportsDir, 'ERGANI_EXPORTS_DIR');
  const url = heartbeatUrlOf(env, 'ARCHIVE_HEARTBEAT_URL');
  const once = () => {
    // Desktop settings can change between runs. A run already in progress finishes on its original clients.
    const employer = loadEmployerConfig(env);
    const clients = employer.branches.map((config) => new ErganiClient(config));
    const noStandingSchedule = noStandingScheduleOf(env);
    markArchiveRun(store, Date.now());
    return runDailyArchive({
      // ⛔ Never creates the record: a missing one is this run's failure (`--init-store` creates it, once).
      openStore: () => {
        if (!existsSync(store)) throw new Error('no record at ERGANI_RECORDS_DB — it is created once at install (--init-store); refusing to start a new one.');
        return openRecordStore(store);
      },
      clients,
      noStandingSchedule,
      realm: employer.erganiRealm,
      employerAfm: employer.employerAfm,
      archiveFrom: env['ARCHIVE_FROM'] ?? '',
      exportsDir,
      now: Date.now,
      beat: url === undefined ? undefined : heartbeatSender(url),
      log,
    });
  };

  if (values.once) return (await once()).kind === 'up' ? 0 : 1;
  log(`archive — realm ${employer.erganiRealm}, ${employer.branches.length} branch(es); daily at ${values.at} (Athens)`);
  let due = dueAtStart(store, Date.now());
  if (!due) log('a run began less than a day ago — the next one at the daily time');
  for (;;) {
    if (due) {
      try {
        await once();
      } catch (error) {
        // A run that cannot even start (no record, a bad ARCHIVE_FROM) says so and tries again tomorrow; the monitor,
        // told nothing, turns red.
        log(`failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    due = true;
    const next = nextRunAfter(Date.now(), values.at, athensInstant);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, next - Date.now())));
  }
}
