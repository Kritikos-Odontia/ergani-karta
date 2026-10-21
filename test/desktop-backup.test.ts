// SPDX-License-Identifier: EUPL-1.2
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUPS, KEEP, backupAndRecord, backupDue, backupNow } from '../src/desktop/backup.js';
import { hashPassword } from '../src/desktop/owner/auth.js';
import { desktopPaths } from '../src/desktop/paths.js';
import { readDesktopState, writeDesktopState } from '../src/desktop/state.js';
import { claimRecordStore, openRecordStore } from '../src/records/store.js';
import { initStampStore } from '../src/stamp/store.js';
import { AFM } from './fixtures/people.js';

/**
 * THE DESKTOP BACKUP (src/desktop/backup.ts) — real stores in a scratch folder, copied to another. ⛔ Fabricated ΑΦΜ.
 */
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
};
const AT = Date.parse('2026-10-21T22:00:00Z');

function installation() {
  const paths = desktopPaths(scratch('karta-data-'));
  mkdirSync(join(paths.root, 'stamp'), { recursive: true });
  mkdirSync(join(paths.root, 'records'), { recursive: true });
  initStampStore(paths.stampDb, { name: 'karta', realm: 'local', employerAfm: AFM.employer }, ['0'], 'now').close();
  const records = openRecordStore(paths.recordsDb);
  claimRecordStore(records, AFM.employer, 'now');
  records.close();
  mkdirSync(join(paths.exports, 'kartes-1-x'), { recursive: true });
  writeFileSync(join(paths.exports, 'kartes-1-x', 'page.html'), '<p>x</p>');
  writeDesktopState(paths.desktop, { ownerPassword: hashPassword('a long owner password'), nightUpdates: true });
  return paths;
}

describe('the backup', () => {
  it('copies both stores whole and the exports into a new private folder — each one readable on its own', () => {
    const paths = installation();
    const stick = scratch('usb-');
    const target = backupNow(paths, stick, AT);
    expect(target).toBe(join(stick, BACKUPS, 'karta-20261021T220000'));
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readdirSync(target).sort()).toEqual(['exports', 'records.sqlite', 'stamp.sqlite']);
    const copy = new DatabaseSync(join(target, 'records.sqlite'), { readOnly: true });
    try {
      expect(copy.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.['n']).toBeGreaterThan(3);
    } finally {
      copy.close();
    }
    expect(readdirSync(join(target, 'exports', 'kartes-1-x'))).toEqual(['page.html']);
  });

  it('⛔ refuses a folder that is not there (the stick unplugged), and one inside a code folder', () => {
    const paths = installation();
    expect(() => backupNow(paths, join(tmpdir(), 'no-such-stick-here'), AT)).toThrow(/δεν βρέθηκε/);
    expect(() => backupNow(paths, fileURLToPath(new URL('..', import.meta.url)), AT)).toThrow(/code folder/);
  });

  it(`keeps the newest ${KEEP} backups and removes the older ones`, () => {
    const paths = installation();
    const stick = scratch('usb-');
    for (let day = 0; day < KEEP + 2; day += 1) backupNow(paths, stick, AT + day * 86_400_000);
    const kept = readdirSync(join(stick, BACKUPS)).sort();
    expect(kept).toHaveLength(KEEP);
    expect(kept[0]).toBe('karta-20261023T220000');
  });

  it('is due when a folder is chosen and the last good backup is a day old — or the last one failed', () => {
    expect(backupDue({}, AT)).toBe(false);
    expect(backupDue({ backupFolder: '/x' }, AT)).toBe(true);
    const good = { backupFolder: '/x', lastBackup: { atIso: new Date(AT).toISOString(), ok: true } };
    expect(backupDue(good, AT + 86_400_000 - 1)).toBe(false);
    expect(backupDue(good, AT + 86_400_000)).toBe(true);
    expect(backupDue({ ...good, lastBackup: { ...good.lastBackup, ok: false } }, AT + 1)).toBe(true);
  });

  it('notes every outcome for the home page — a failure with its reason, never silent', () => {
    const paths = installation();
    const lines: string[] = [];
    expect(backupAndRecord(paths, AT, (l) => lines.push(l))).toEqual({ ok: false, problem: 'δεν έχει οριστεί φάκελος αντιγράφων' });
    writeDesktopState(paths.desktop, { ...readDesktopState(paths.desktop)!, backupFolder: join(tmpdir(), 'no-such-stick-here') });
    expect(backupAndRecord(paths, AT, (l) => lines.push(l)).ok).toBe(false);
    expect(readDesktopState(paths.desktop)?.lastBackup).toMatchObject({ ok: false, problem: expect.stringMatching(/USB/) });
    const stick = scratch('usb-');
    writeDesktopState(paths.desktop, { ...readDesktopState(paths.desktop)!, backupFolder: stick });
    expect(backupAndRecord(paths, AT + 60_000, (l) => lines.push(l)).ok).toBe(true);
    expect(readDesktopState(paths.desktop)?.lastBackup).toEqual({ atIso: new Date(AT + 60_000).toISOString(), ok: true });
  });
});
