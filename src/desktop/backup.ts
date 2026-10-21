// SPDX-License-Identifier: EUPL-1.2
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertOutsideCodeFolders, newRequestFolder } from '../code-folders.js';
import type { DesktopPaths } from './paths.js';
import { readDesktopState, writeDesktopState } from './state.js';

/**
 * BACKUP — a copy of the employer's record to a folder the owner chose: a USB stick, or the Dropbox folder (whose own
 * program then carries it off the computer). Every day by itself, and with a button.
 *
 * Each backup is a NEW folder (`<chosen>/Karta Ergasias backups/karta-<UTC time>`), never a merge into an older one:
 *   · both stores copied consistently while the program runs (SQLite's `VACUUM INTO`: a whole, self-contained file,
 *     never half a write);
 *   · the exports folder, as it is.
 * The newest `KEEP` backups are kept; older ones in that folder are removed. ⛔ The chosen folder may not be inside a
 * code folder (code-folders.ts): a backup holds ΑΦΜ and working hours.
 * ⚠ A missing folder — the stick not plugged in, Dropbox moved — is a failed backup, said on the owner's home page;
 * never a silent skip.
 */
export const KEEP = 30;
export const BACKUPS = 'Karta Ergasias backups';

export function backupNow(paths: DesktopPaths, chosen: string, nowMs: number): string {
  if (!existsSync(chosen) || !statSync(chosen).isDirectory()) {
    throw new Error('ο φάκελος των αντιγράφων δεν βρέθηκε — είναι συνδεδεμένο το USB;');
  }
  assertOutsideCodeFolders(chosen, 'ο φάκελος των αντιγράφων');
  const target = newRequestFolder(join(chosen, BACKUPS), 'karta', nowMs);
  for (const [store, name] of [
    [paths.stampDb, 'stamp.sqlite'],
    [paths.recordsDb, 'records.sqlite'],
  ] as const) {
    if (!existsSync(store)) continue;
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      db.prepare('VACUUM INTO ?').run(join(target, name));
    } finally {
      db.close();
    }
  }
  if (existsSync(paths.exports)) cpSync(paths.exports, join(target, 'exports'), { recursive: true });
  prune(join(chosen, BACKUPS));
  return target;
}

/** Keep the newest `KEEP` backups (by their names, which sort by time); remove the rest. */
function prune(folder: string): void {
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
