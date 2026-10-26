// SPDX-License-Identifier: EUPL-1.2
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertOutsideCodeFolders, newRequestFolder } from '../code-folders.js';
import type { DesktopPaths } from './paths.js';
import { DesktopState, readDesktopState, writeDesktopState } from './state.js';
import { openRecovery, sealRecovery } from './recovery-seal.js';
import { z } from 'zod';

/**
 * BACKUP — a copy of the employer's record to a folder the owner chose: a USB stick, or the Dropbox folder (whose own
 * program then carries it off the computer). Every day by itself, and with a button.
 *
 * Each backup is a NEW folder (`<chosen>/Karta Ergasias backups/karta-<UTC time>`), never a merge into an older one:
 *   · both stores copied consistently while the program runs (SQLite's `VACUUM INTO`: a whole, self-contained file,
 *     never half a write);
 *   · the exports folder, as it is;
 *   · settings and desktop state sealed to the owner's existing password, including the ministry credential; the
 *     authenticated envelope also binds the two copied SQLite files by their SHA-256 (docs/DECISIONS.md).
 * The newest `KEEP` backups are kept; older ones in that folder are removed. ⛔ The chosen folder may not be inside a
 * code folder (code-folders.ts): a backup holds ΑΦΜ and working hours.
 * ⚠ A missing folder — the stick not plugged in, Dropbox moved — is a failed backup, said on the owner's home page;
 * never a silent skip.
 */
export const KEEP = 30;
export const BACKUPS = 'Karta Ergasias backups';
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const Recovery = z.object({ settings: z.string(), desktop: DesktopState, hashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)) });

export function backupNow(paths: DesktopPaths, chosen: string, nowMs: number): string {
  if (!existsSync(chosen) || !statSync(chosen).isDirectory()) {
    throw new Error('ο φάκελος των αντιγράφων δεν βρέθηκε — είναι συνδεδεμένο το USB;');
  }
  assertOutsideCodeFolders(chosen, 'ο φάκελος των αντιγράφων');
  // ⛔ Both stores, or no backup: one without the other is not a copy of the record, and counting it among the ones kept
  // would push out a whole one. (The program, once set up, has both; a missing one is a lost record — main.ts.)
  const missing = [paths.stampDb, paths.recordsDb].filter((store) => !existsSync(store));
  if (missing.length > 0) throw new Error(`λείπει το αρχείο ${missing.join(', ')} — δεν γράφτηκε αντίγραφο· τα προηγούμενα μένουν`);
  const desktop = readDesktopState(paths.desktop);
  if (desktop === undefined) throw new Error('λείπουν οι ρυθμίσεις εργοδότη — δεν γράφτηκε αντίγραφο');
  const settings = readFileSync(paths.settings, 'utf8');
  // Written as `<name>.partial`, renamed to its own name only when whole: a backup that failed half-way (the stick
  // pulled out, the disk full) is removed, and never counts among the ones kept.
  const target = newRequestFolder(join(chosen, BACKUPS), 'karta', nowMs);
  const partial = `${target}.partial`;
  renameSync(target, partial);
  try {
    for (const [store, name] of [
      [paths.stampDb, 'stamp.sqlite'],
      [paths.recordsDb, 'records.sqlite'],
    ] as const) {
      const db = new DatabaseSync(store, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.prepare('VACUUM INTO ?').run(join(partial, name));
      } finally {
        db.close();
      }
    }
    if (existsSync(paths.exports)) cpSync(paths.exports, join(partial, 'exports'), { recursive: true });
    const hashes = Object.fromEntries(['stamp.sqlite', 'records.sqlite'].map((name) => [name, digest(join(partial, name))]));
    writeFileSync(join(partial, 'recovery.json'), sealRecovery(JSON.stringify({ settings, desktop, hashes }), desktop.ownerPassword), { mode: 0o600 });
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  prune(join(chosen, BACKUPS));
  return target;
}

/** Restore only to a fresh installation. No service starts here; the persistent recovery hold precedes all copies. */
export function restoreBackup(paths: DesktopPaths, folder: string, password: string, nowMs: number): void {
  assertOutsideCodeFolders(paths.root, 'ο φάκελος επαναφοράς');
  assertOutsideCodeFolders(folder, 'το αντίγραφο');
  if ([paths.settings, paths.desktop, join(paths.root, 'stamp'), join(paths.root, 'records'), paths.exports].some(existsSync)) {
    throw new Error('η επαναφορά χρειάζεται άδειο φάκελο δεδομένων — δεν αντικαθιστά υπάρχον αρχείο');
  }
  let recovered: z.infer<typeof Recovery>;
  try {
    recovered = Recovery.parse(JSON.parse(openRecovery(readFileSync(join(folder, 'recovery.json'), 'utf8'), password)));
    for (const name of ['stamp.sqlite', 'records.sqlite']) {
      if (digest(join(folder, name)) !== recovered.hashes[name]) throw new Error();
    }
  } catch {
    throw new Error('λάθος κωδικός εργοδότη ή ελλιπές / αλλοιωμένο αντίγραφο');
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  // Written FIRST: even a power loss part-way through recovery cannot start the outbox with an old pending card.
  writeDesktopState(paths.desktop, { ...recovered.desktop, storesSince: recovered.desktop.storesSince ?? new Date(nowMs).toISOString(), recovery: { restoredAt: new Date(nowMs).toISOString() } });
  for (const [name, target] of [['stamp.sqlite', paths.stampDb], ['records.sqlite', paths.recordsDb]] as const) {
    mkdirSync(join(paths.root, name === 'stamp.sqlite' ? 'stamp' : 'records'), { recursive: true, mode: 0o700 });
    cpSync(join(folder, name), target, { errorOnExist: true, force: false });
  }
  if (existsSync(join(folder, 'exports'))) cpSync(join(folder, 'exports'), paths.exports, { recursive: true });
  writeFileSync(paths.settings, recovered.settings, { mode: 0o600, flag: 'wx' });
}

/** Keep the newest `KEEP` whole backups (by their names, which sort by time); remove the rest, and stale partials. */
function prune(folder: string): void {
  for (const stale of readdirSync(folder).filter((name) => /^karta-\d{8}T\d{6}\.partial$/.test(name))) rmSync(join(folder, stale), { recursive: true, force: true });
  const backups = readdirSync(folder).filter((name) => /^karta-\d{8}T\d{6}$/.test(name)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) rmSync(join(folder, old), { recursive: true, force: true });
}

/** Whether a daily backup is due: a folder is chosen, and no good backup in the last day. */
export function backupDue(state: { backupFolder?: string | undefined; lastBackup?: { atIso: string; ok: boolean } | undefined }, nowMs: number): boolean {
  if (state.backupFolder === undefined) return false;
  const last = state.lastBackup;
  return last === undefined || !last.ok || nowMs - Date.parse(last.atIso) >= 86_400_000;
}

/**
 * Folders worth offering: the Dropbox folder and removable drives this computer has now. Only offered — the owner
 * picks one, or types another.
 */
export function backupCandidates(system: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const found: string[] = [];
  const dirs = (parent: string) => {
    try {
      return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
    } catch {
      return [];
    }
  };
  for (const dropbox of [join(home, 'Dropbox'), ...dirs(join(home, 'Library', 'CloudStorage')).filter((d) => /Dropbox/i.test(d))]) {
    if (existsSync(dropbox)) found.push(dropbox);
  }
  if (system === 'darwin') found.push(...dirs('/Volumes').filter((d) => d !== '/Volumes/Macintosh HD'));
  if (system === 'linux') {
    const user = home.split('/').pop() ?? '';
    found.push(...dirs(join('/media', user)), ...dirs(join('/run/media', user)));
  }
  if (system === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${letter}:\\`)) found.push(`${letter}:\\`);
  }
  return found;
}

/**
 * Run a backup to the chosen folder and note its outcome in `desktop.json` (the home page shows it). A failure is
 * noted, never thrown away: the owner sees «το τελευταίο αντίγραφο απέτυχε» and why.
 */
export function backupAndRecord(paths: DesktopPaths, nowMs: number, log: (line: string) => void): { ok: true; folder: string } | { ok: false; problem: string } {
  const state = readDesktopState(paths.desktop);
  if (state?.backupFolder === undefined) return { ok: false, problem: 'δεν έχει οριστεί φάκελος αντιγράφων' };
  const atIso = new Date(nowMs).toISOString();
  try {
    const folder = backupNow(paths, state.backupFolder, nowMs);
    writeDesktopState(paths.desktop, { ...state, lastBackup: { atIso, ok: true } });
    log(`backup written to ${folder}`);
    return { ok: true, folder };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    writeDesktopState(paths.desktop, { ...state, lastBackup: { atIso, ok: false, problem } });
    log(`backup failed — ${problem}`);
    return { ok: false, problem };
  }
}
