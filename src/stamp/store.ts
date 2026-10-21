// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { assertOutsideCodeFolders } from '../code-folders.js';
import { BRANCH_CODE, type ErganiRealm } from '../config.js';
import { stampMigrationFiles } from '../assets.js';
import { migrate, migrationsOf, type Migration } from '../records/store.js';

/**
 * THE STAMPING STORE — one SQLite file per employer, for every branch it has: its staff, the devices enrolled at each
 * branch, every card stamped at a branch's page, every attempt to file it, every human decision about it, and
 * ΕΡΓΑΝΗ's proof.
 *
 * ── ⛔⛔ THE SYSTEM OF RECORD, NOT A CACHE (docs/RULES.md rule 2) ─────────────────────────────────
 * ΕΡΓΑΝΗ keeps card data six months; the employer owes five years (retain ten). Cards and everything said about
 * them are append-only, enforced by the database itself (`migrations/001-stamping.sql`). No purge, ever.
 *
 * ── ⭐ ONE FILE PER EMPLOYER, EVERY BRANCH IN IT ──────────────────────────────────────────────────
 * Rule 3's bound (an ΕΝΑΡΞΗ is never sent after a later card of the same person and day) and the working day of a ΛΗΞΗ
 * after midnight are questions about the PERSON's day, wherever she stamped. A store per branch could not answer them:
 * an ΕΝΑΡΞΗ at one branch and the ΛΗΞΗ at another would each sit in a store that cannot see the other. So every branch
 * of the employer is in the one store, and every card carries its branch.
 *
 * The same idiom as the archive's record store (`src/records/store.ts`): Node's built-in SQLite, loaded with
 * `process.getBuiltinModule` (a static import fails under vitest), forward-only numbered migrations, the default
 * rollback journal (one file for a backup, no `-wal` beside it). The store remembers, at `init`, the employer it
 * belongs to and its branches — and refuses to open for any other (`assertInstance`, `assertBranches`).
 */
const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type StampStore = DatabaseSync;

export function stampMigrations(): Migration[] {
  return migrationsOf(stampMigrationFiles());
}

/** What this store is for. Written once by `initStampStore`. */
export interface Instance {
  name: string;
  realm: ErganiRealm;
  employerAfm: string;
}

/** The store was made for another employer or realm than the one asking. Nothing was read or written. */
export class InstanceMismatchError extends Error {
  constructor(what: string) {
    super(
      `this store belongs to another ${what} than the configuration asks for. Refusing to open it: one store holds ` +
        'one employer\'s cards, in one realm.',
    );
    this.name = 'InstanceMismatchError';
  }
}

/** The store's branches and the configuration's are not the same list. Nothing was read or written. */
export class BranchMismatchError extends Error {
  constructor(held: readonly string[], configured: readonly string[]) {
    const missing = held.filter((b) => !configured.includes(b));
    const extra = configured.filter((b) => !held.includes(b));
    super(
      'the store and ERGANI_BRANCHES do not list the same branches' +
        (missing.length > 0 ? ` — the store holds ${missing.join(', ')}, which has no login in the configuration` : '') +
        (extra.length > 0
          ? ` — the configuration lists ${extra.join(', ')}, which the store does not hold: add it once with ` +
            extra.map((b) => `\`docker compose run --rm stamp ergani admin add-branch --branch ${b}\``).join(' and ') +
            ', then `docker compose up -d`'
          : '') +
        '. Refusing to open it: every card must be filed with its own branch\'s login.',
    );
    this.name = 'BranchMismatchError';
  }
}

/**
 * Open an EXISTING store for `expected` and exactly `branches`, bringing its schema up to date. ⛔ It never creates
 * one: a missing store is an error here, never a reason to start a second record (`initStampStore` does that, once,
 * on purpose). `branches` undefined: any branches (the owner's tools that add one).
 */
export function openStampStore(path: string, expected: Instance, branches?: readonly string[]): StampStore {
  assertOutsideCodeFolders(path, 'The stamping store');
  if (!existsSync(path)) throw new Error('there is no stamping store at STAMP_DB. Create one with `init`, once.');
  const db = new Database(path, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA recursive_triggers = ON');
    // ⓘ The archive container, a backup or `admin` may hold the file a moment: wait for it rather than fail a stamp.
    db.exec('PRAGMA busy_timeout = 5000');
    const initialised = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance'").get();
    if (initialised === undefined) throw new Error('this file is not a stamping store. Nothing was changed.');
    migrate(db, stampMigrations());
    assertInstance(db, expected);
    if (branches !== undefined) assertBranches(db, branches);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Create the store at `path` for `instance` and its first `branches`, once. Refuses a path that already holds a
 * store, so a mistyped command cannot turn an existing record into another employer's.
 */
export function initStampStore(path: string, instance: Instance, branches: readonly string[], nowIso: string): StampStore {
  // ⓘ `:memory:` is for tests.
  if (path !== ':memory:') assertOutsideCodeFolders(path, 'The stamping store');
  if (branches.length === 0) throw new Error('a store needs at least one branch.');
  const db = new Database(path, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA recursive_triggers = ON');
    const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (existing !== undefined) throw new Error('a stamping store already exists here. Nothing was changed.');
    migrate(db, stampMigrations());
    db.prepare('INSERT INTO instance (id, name, realm, employer_afm, created_at) VALUES (1, ?, ?, ?, ?)').run(
      instance.name,
      instance.realm,
      instance.employerAfm,
      nowIso,
    );
    for (const code of branches) addBranch(db, code, nowIso);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Record a branch the store will hold cards for, once. A branch is never removed (its cards are the record). */
export function addBranch(db: StampStore, code: string, nowIso: string): void {
  if (!BRANCH_CODE.test(code)) throw new Error('a branch code is its number in plain digits (0, 1, 12 — never 01).');
  if (storeBranches(db).includes(code)) throw new Error(`branch ${code} is already in this store.`);
  db.prepare('INSERT INTO branches (code, added_at) VALUES (?, ?)').run(code, nowIso);
}

/** The branches this store holds, in number order. */
export function storeBranches(db: StampStore): string[] {
  return db
    .prepare('SELECT code FROM branches ORDER BY CAST(code AS INTEGER)')
    .all()
    .map((r) => String(r['code']));
}

export function instanceOf(db: StampStore): Instance | undefined {
  const row = db.prepare('SELECT name, realm, employer_afm FROM instance WHERE id = 1').get();
  if (row === undefined) return undefined;
  return {
    name: String(row['name']),
    realm: String(row['realm']) as ErganiRealm,
    employerAfm: String(row['employer_afm']),
  };
}

/** Refuse unless the store was made for exactly this employer and realm, under this name. */
export function assertInstance(db: StampStore, expected: Instance): void {
  const held = instanceOf(db);
  if (held === undefined) throw new Error('this stamping store has no employer recorded. It was never initialised.');
  if (held.name !== expected.name) throw new InstanceMismatchError('instance name');
  if (held.employerAfm !== expected.employerAfm) throw new InstanceMismatchError('employer');
  if (held.realm !== expected.realm) throw new InstanceMismatchError('ΕΡΓΑΝΗ realm');
}

/**
 * Refuse unless the store holds exactly the configured branches. ⓘ Both ways matter: a branch the store holds with
 * no login could never file its cards, and a configured branch the store does not hold must be added on purpose.
 */
export function assertBranches(db: StampStore, configured: readonly string[]): void {
  const held = storeBranches(db);
  const same = held.length === configured.length && held.every((b) => configured.includes(b));
  if (!same) throw new BranchMismatchError(held, configured);
}

/** An ISO-8601 instant for the `*_at` columns, from the service's clock. */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}
