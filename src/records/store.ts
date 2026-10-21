// SPDX-License-Identifier: EUPL-1.2
import { recordMigrationFiles, type AssetFile } from '../assets.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ErganiRealm } from '../config.js';

/**
 * THE RECORD STORE — the employer's five-year, per-employee record of working time, in one SQLite file, for every
 * branch of ONE employer (`employer`, below).
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────────
 * ΥΑ 113169/2023: the employer keeps card data for FIVE years, and each employee may see their own;
 * failing to retain it is €4,000. ΕΡΓΑΝΗ keeps six months. The monthly pull (`pull.ts`) copies each
 * month out of ΕΡΓΑΝΗ into this file before ΕΡΓΑΝΗ forgets it.
 *
 * ── ⛔⛔ NEVER DELETE A ROW. This is the whole design. ─────────────────────────────────────────────
 * The live tables ARE the five-year record. A backup is usually pruned within a year — twelve months
 * against a five-year duty — so the backup is insurance, not the record: a row deleted here is gone
 * from the duty's point of view within a year.
 * ⇒ No TTL. No purge job. No lifecycle tier. No "cleanup" command. No down migration. Five staff make
 * on the order of 1,500 stamp rows a year; five years of them is smaller than one day of most logs.
 * ⛔ A LATER SESSION MUST NOT ADD ONE. The schema backs this with triggers that refuse DELETE and UPDATE
 * on every table of the record (`migrations/001-the-record.sql`), and `recursive_triggers` is switched
 * on below so that an INSERT OR REPLACE, which deletes the row it replaces, is refused as well.
 *
 * ── ONE FILE, NODE'S BUILT-IN SQLITE ──────────────────────────────────────────────────────────────
 * No new dependency, and one file is exactly what a nightly backup picks up.
 * ⛔ `node:sqlite` is loaded with `process.getBuiltinModule`, NOT a static import: under this repo's
 * vitest 2.1 a static `import … from 'node:sqlite'` fails («Failed to load url sqlite») — vite strips
 * the `node:` prefix, and `sqlite` exists only with it (measured). Do not "fix" it back. The
 * `import type` above is erased before vite sees it.
 * ⓘ The default rollback journal is kept, not WAL: between pulls the record is the one file, with no
 * `-wal` beside it for a backup to miss.
 */
// ⓘ A Node 22 too old to ship `node:sqlite` without a flag fails here, loudly, before any read or write.
const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type RecordStore = DatabaseSync;

/**
 * Open the record at `path` (a file, or `:memory:` in tests), bringing its schema up to date. SQLite
 * creates the file if it does not exist — whether that is wanted is the caller's decision (the CLI
 * refuses unless told to, so a mistyped path cannot quietly start a second record).
 */
export function openRecordStore(path: string, migrations: readonly Migration[] = recordMigrations()): RecordStore {
  const db = new Database(path, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA recursive_triggers = ON');
    // A pull by hand that overlaps the daily run waits for it, as the stamping store does, instead of failing at its
    // last write after the whole walk.
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Migrations: numbered, forward-only, recorded
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d{3})-[a-z0-9-]+\.sql$/;

/**
 * The record store's migrations (`migrations/`), in order: `NNN-name.sql`, numbered 001, 002, … with no gap.
 * ⛔ There are no down migrations and there never will be: a rollback that drops a record table is a
 * purge path by another name.
 */
export function recordMigrations(): Migration[] {
  return migrationsOf(recordMigrationFiles());
}

/** Numbered migration files → migrations in order; refuses a gap or a repeat. (Also the stamping store's: stamp/store.ts.) */
export function migrationsOf(files: readonly AssetFile[]): Migration[] {
  const migrations = files
    .filter((file) => MIGRATION_FILE.test(file.name))
    .map((file) => ({ version: Number(file.name.slice(0, 3)), name: file.name, sql: file.text }))
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 001, 002, … with no gap or repeat; found ${m.name}`);
  });
  return migrations;
}

/**
 * Apply every migration the store has not recorded, in order, each in one transaction with the row
 * that records it — so a migration is either wholly applied and recorded, or not at all. A migration
 * file must therefore not open or close a transaction itself.
 *
 * ⛔ A store that records a migration this code does not have was written by newer code, and is
 * refused rather than written to under an older understanding of its schema.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
  for (const { version, name } of applied) {
    const known = migrations.find((m) => m.version === version);
    if (known === undefined || known.name !== name) {
      throw new Error(
        `this record store has migration ${name} applied, which this version of the code does not have — ` +
          'it was written by newer code. Refusing to open it.',
      );
    }
  }
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  );
  for (const migration of migrations) {
    if (applied.some((a) => a.version === migration.version)) continue;
    inTransaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
    });
  }
}

/** Run `work` inside one write transaction: all of it is kept, or none of it. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Whose record this is
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The store belongs to another employer than the configuration names. Nothing was sent or written. */
export class EmployerMismatchError extends Error {
  constructor() {
    super(
      'this record store belongs to another employer than ERGANI_EMPLOYER_AFM names. Refusing it: one store holds one ' +
        'employer\'s five-year record — check ERGANI_RECORDS_DB and the configuration it runs with.',
    );
    this.name = 'EmployerMismatchError';
  }
}

/** The employer's ΑΦΜ the record belongs to, or `undefined` while it has none yet. */
export function recordEmployer(db: DatabaseSync): string | undefined {
  const row = db.prepare('SELECT afm FROM employer WHERE id = 1').get();
  return row === undefined ? undefined : String(row['afm']);
}

/**
 * Make sure the record belongs to `afm`: on a store that has none yet and no pull either (a new one), record it; on
 * any other store, refuse unless it is this employer's. Runs inside the caller's transaction when there is one.
 */
export function claimRecordStore(db: DatabaseSync, afm: string, nowIso: string): void {
  const held = recordEmployer(db);
  if (held === undefined) {
    if (db.prepare('SELECT 1 FROM pulls LIMIT 1').get() !== undefined) throw new EmployerMismatchError();
    db.prepare('INSERT INTO employer (id, afm, created_at) VALUES (1, ?, ?)').run(afm, nowIso);
    return;
  }
  if (held !== afm) throw new EmployerMismatchError();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading the record: what is held, and whether ΕΡΓΑΝΗ still says it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One `EX_BASE_07` row as the record holds it. Values exactly as ΕΡΓΑΝΗ sent them. */
export interface HeldStamp {
  branch: string;
  /** `YYYY-MM-DD` — the reference date the pull asked about. */
  day: string;
  afm: string;
  /** `Date` as ΕΡΓΑΝΗ sent it. */
  date: string;
  hourFrom: string;
  hourTo: string;
  /** The night-shift flag: the exit fell on the calendar day after `date`. */
  endsNextDay: boolean;
  firstPullId: number;
  /**
   * How many times the LATEST successful read of this day listed this row. ⚠ `0` means ΕΡΓΑΝΗ no longer
   * answers it — changed or withdrawn upstream. The row is kept: that is a finding, not a tidy-up.
   */
  inLatestRead: number;
}

/** One `EX_BASE_08` row as the record holds it. Values exactly as ΕΡΓΑΝΗ sent them. */
export interface HeldSchedule {
  branch: string;
  day: string;
  afm: string;
  type: string;
  hourFrom: string;
  hourTo: string;
  breakMinutes: string;
  breakInWork: string;
  extra: string;
  firstPullId: number;
  /** As `HeldStamp.inLatestRead`. */
  inLatestRead: number;
}

/**
 * The latest pull that READ `service` for the row's branch and day — a failed read of a day says nothing
 * about the rows held for it. Correlated on the outer query's `r` alias.
 */
const latestRead = (service: string) => `(
  SELECT max(d.pull_id) FROM day_reads d JOIN pulls p ON p.id = d.pull_id
  WHERE p.branch = r.branch AND d.service = '${service}' AND d.day = r.day AND d.rows IS NOT NULL)`;

/** Every stamp row held for a reference date in `from`…`to` (`YYYY-MM-DD`, inclusive), in date order. */
export function heldStamps(db: DatabaseSync, from: string, to: string): HeldStamp[] {
  const rows = db
    .prepare(
      `SELECT r.branch, r.day, r.afm, r.date, r.hour_from, r.hour_to, r.ends_next_day, r.first_pull_id,
              coalesce((SELECT s.copies FROM stamp_sightings s
                        WHERE s.stamp_id = r.id AND s.pull_id = ${latestRead('EX_BASE_07')}), 0) AS in_latest_read
       FROM stamps r WHERE r.day BETWEEN ? AND ? ORDER BY r.day, r.branch, r.afm, r.id`,
    )
    .all(from, to) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    branch: String(r['branch']),
    day: String(r['day']),
    afm: String(r['afm']),
    date: String(r['date']),
    hourFrom: String(r['hour_from']),
    hourTo: String(r['hour_to']),
    endsNextDay: r['ends_next_day'] === 1,
    firstPullId: Number(r['first_pull_id']),
    inLatestRead: Number(r['in_latest_read']),
  }));
}

/** Every declared-schedule row held for a reference date in `from`…`to` (inclusive), in date order. */
export function heldSchedule(db: DatabaseSync, from: string, to: string): HeldSchedule[] {
  const rows = db
    .prepare(
      `SELECT r.branch, r.day, r.afm, r.type, r.hour_from, r.hour_to, r.break_minutes, r.break_in_work, r.extra,
              r.first_pull_id,
              coalesce((SELECT s.copies FROM schedule_sightings s
                        WHERE s.schedule_id = r.id AND s.pull_id = ${latestRead('EX_BASE_08')}), 0) AS in_latest_read
       FROM schedule r WHERE r.day BETWEEN ? AND ? ORDER BY r.day, r.branch, r.afm, r.id`,
    )
    .all(from, to) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    branch: String(r['branch']),
    day: String(r['day']),
    afm: String(r['afm']),
    type: String(r['type']),
    hourFrom: String(r['hour_from']),
    hourTo: String(r['hour_to']),
    breakMinutes: String(r['break_minutes']),
    breakInWork: String(r['break_in_work']),
    extra: String(r['extra']),
    firstPullId: Number(r['first_pull_id']),
    inLatestRead: Number(r['in_latest_read']),
  }));
}

/** One run of the monthly pull, as the log holds it. */
export interface PullLogEntry {
  id: number;
  month: string;
  realm: ErganiRealm;
  branch: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'complete' | 'incomplete' | 'stopped';
  stampRows: number;
  scheduleRows: number;
  newStampRows: number;
  newScheduleRows: number;
  stampsNoLongerAnswered: number;
  scheduleNoLongerAnswered: number;
}

/** The pull log, oldest first. */
export function pullLog(db: DatabaseSync): PullLogEntry[] {
  const rows = db.prepare('SELECT * FROM pulls ORDER BY id').all() as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    id: Number(r['id']),
    month: String(r['month']),
    realm: String(r['realm']) as ErganiRealm,
    branch: String(r['branch']),
    startedAt: String(r['started_at']),
    finishedAt: String(r['finished_at']),
    outcome: String(r['outcome']) as PullLogEntry['outcome'],
    stampRows: Number(r['stamp_rows']),
    scheduleRows: Number(r['schedule_rows']),
    newStampRows: Number(r['new_stamp_rows']),
    newScheduleRows: Number(r['new_schedule_rows']),
    stampsNoLongerAnswered: Number(r['stamps_no_longer_answered']),
    scheduleNoLongerAnswered: Number(r['schedule_no_longer_answered']),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading the record without being able to write it — for the export (`src/export/`)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open an EXISTING record READ-ONLY. SQLite itself refuses every write through this handle, so code
 * that only reads the record — the per-employee export, the comparison — cannot damage the five-year
 * record whatever it does. Nothing is migrated: a store whose applied migrations are not exactly this
 * code's is refused (older: one `npm run pull` brings it up to date; newer: this code cannot read it).
 */
export function openRecordStoreForReading(path: string, migrations: readonly Migration[] = recordMigrations()): RecordStore {
  const db = new Database(path, { readOnly: true });
  try {
    const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (hasLog === undefined) throw new Error('this file is not a record store: it has no schema_migrations table.');
    const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    const current =
      applied.length === migrations.length &&
      applied.every((a, i) => a['version'] === migrations[i]?.version && a['name'] === migrations[i]?.name);
    if (!current) {
      throw new Error(
        `this record store's schema (${applied.map((a) => String(a['name'])).join(', ')}) is not this code's ` +
          `(${migrations.map((m) => m.name).join(', ')}). If it is older, one pull brings it up to date; ` +
          'if it is newer, this code cannot read it.',
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** A day the record holds ΕΡΓΑΝΗ's answer for: some pull read `service` for it successfully. */
export interface ReadDay {
  service: 'EX_BASE_07' | 'EX_BASE_08';
  branch: string;
  /** `YYYY-MM-DD`. */
  day: string;
  /** When the LATEST pull that read it successfully finished — an ISO instant. */
  readAt: string;
}

const READ_DAY_COLUMNS = 'd.service, p.branch, d.day, p.finished_at';
const toReadDay = (r: Record<string, unknown>): ReadDay => ({
  service: String(r['service']) as ReadDay['service'],
  branch: String(r['branch']),
  day: String(r['day']),
  readAt: String(r['finished_at']),
});

/**
 * Every (service, branch, day) in `from`…`to` (inclusive) that a pull read successfully, with its latest
 * successful read. ⚠ A day NOT listed is a day the record knows NOTHING about — never a day with no rows.
 * Saying "no stamp" for it would be a false statement about a person's working day.
 */
export function daysRead(db: DatabaseSync, from: string, to: string): ReadDay[] {
  return db
    .prepare(
      `SELECT ${READ_DAY_COLUMNS} FROM day_reads d JOIN pulls p ON p.id = d.pull_id
       WHERE d.rows IS NOT NULL AND d.day BETWEEN ? AND ?
         AND d.pull_id = (SELECT max(d2.pull_id) FROM day_reads d2 JOIN pulls p2 ON p2.id = d2.pull_id
                          WHERE p2.branch = p.branch AND d2.service = d.service AND d2.day = d.day
                            AND d2.rows IS NOT NULL)
       ORDER BY d.day, d.service, p.branch`,
    )
    .all(from, to)
    .map(toReadDay);
}

/** The newest day the record holds a successful read of `service` for — how fresh the record is. */
export function newestRead(db: DatabaseSync, service: ReadDay['service']): ReadDay | undefined {
  const row = db
    .prepare(
      `SELECT ${READ_DAY_COLUMNS} FROM day_reads d JOIN pulls p ON p.id = d.pull_id
       WHERE d.rows IS NOT NULL AND d.service = ? ORDER BY d.day DESC, d.pull_id DESC LIMIT 1`,
    )
    .get(service);
  return row === undefined ? undefined : toReadDay(row);
}
