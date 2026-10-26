// SPDX-License-Identifier: EUPL-1.2
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreMissing, ensureStores, restoreSteps } from '../src/desktop/main.js';
import { BACKUPS, KEEP, backupAndRecord, backupDue, backupNow, restoreBackup } from '../src/desktop/backup.js';
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
  writeFileSync(paths.settings, `ERGANI_EMPLOYER_AFM=${AFM.employer}\nERGANI_BRANCH_0_PASSWORD=Fixture.p1\n`, { mode: 0o600 });
  return paths;
}

describe('the backup', () => {
  it('copies both stores whole and the exports into a new private folder — each one readable on its own', () => {
    const paths = installation();
    const stick = scratch('usb-');
    const target = backupNow(paths, stick, AT);
    expect(target).toBe(join(stick, BACKUPS, 'karta-20261021T220000'));
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readdirSync(target).sort()).toEqual(['exports', 'records.sqlite', 'recovery.json', 'stamp.sqlite']);
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

  it('a backup that fails half-way leaves nothing behind, and never pushes a whole one out of the 30 kept', () => {
    const paths = installation();
    const stick = scratch('usb-');
    for (let day = 0; day < KEEP; day += 1) backupNow(paths, stick, AT + day * 86_400_000);
    writeFileSync(paths.recordsDb, 'not a database'); // the copy of the second store fails
    for (let day = KEEP; day < KEEP + 3; day += 1) expect(() => backupNow(paths, stick, AT + day * 86_400_000)).toThrow();
    const left = readdirSync(join(stick, BACKUPS)).sort();
    expect(left).toHaveLength(KEEP);
    expect(left.every((name) => /^karta-\d{8}T\d{6}$/.test(name))).toBe(true);
    expect(readdirSync(join(stick, BACKUPS, left[0]!)).sort()).toEqual(['exports', 'records.sqlite', 'recovery.json', 'stamp.sqlite']);
  });

  it('⛔ a store gone while the program runs: no backup, none of the 30 whole ones pushed out — each kept one holds both', () => {
    const paths = installation();
    const stick = scratch('usb-');
    for (let day = 0; day < KEEP; day += 1) backupNow(paths, stick, AT + day * 86_400_000);
    rmSync(paths.stampDb);
    expect(() => backupNow(paths, stick, AT + KEEP * 86_400_000)).toThrow(/λείπει το αρχείο .*stamp\.sqlite/);
    const left = readdirSync(join(stick, BACKUPS)).sort();
    expect(left).toHaveLength(KEEP);
    for (const name of left) expect(readdirSync(join(stick, BACKUPS, name))).toEqual(expect.arrayContaining(['records.sqlite', 'stamp.sqlite']));
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

  it('recovers settings, owner access, both identical record files and exports on a fresh computer; sending stays held', () => {
    const paths = installation();
    const target = backupNow(paths, scratch('usb-'), AT);
    const envelope = readFileSync(join(target, 'recovery.json'), 'utf8');
    expect(envelope).not.toContain('Fixture.p1');
    expect(envelope).not.toContain(readDesktopState(paths.desktop)!.ownerPassword);
    const fresh = desktopPaths(scratch('new-computer-'));
    restoreBackup(fresh, target, 'a long owner password', AT + 1);
    expect(readFileSync(fresh.settings)).toEqual(readFileSync(paths.settings));
    for (const [file, source] of [['stamp.sqlite', fresh.stampDb], ['records.sqlite', fresh.recordsDb]]) {
      expect(readFileSync(source!)).toEqual(readFileSync(join(target, file!)));
    }
    expect(readFileSync(join(fresh.exports, 'kartes-1-x', 'page.html'), 'utf8')).toBe('<p>x</p>');
    expect(readDesktopState(fresh.desktop)).toMatchObject({
      ownerPassword: readDesktopState(paths.desktop)!.ownerPassword,
      recovery: { restoredAt: new Date(AT + 1).toISOString() },
    });
    expect(statSync(fresh.settings).mode & 0o777).toBe(0o600);
    expect(() => restoreBackup(fresh, target, 'a long owner password', AT + 2)).toThrow(/άδει/);
  });

  it('a wrong recovery password or altered record is refused before anything is restored', () => {
    const paths = installation();
    const target = backupNow(paths, scratch('usb-'), AT);
    const fresh = desktopPaths(scratch('new-computer-'));
    expect(() => restoreBackup(fresh, target, 'wrong password', AT)).toThrow(/κωδικ|αντίγραφο/);
    expect(readdirSync(fresh.root)).toEqual([]);
    writeFileSync(join(target, 'stamp.sqlite'), 'altered');
    expect(() => restoreBackup(fresh, target, 'a long owner password', AT)).toThrow(/αντίγραφο/);
    expect(readdirSync(fresh.root)).toEqual([]);
  });

  it('after the owner changes password, each backup still opens only with the password used for that snapshot', () => {
    const paths = installation();
    const stick = scratch('usb-');
    const older = backupNow(paths, stick, AT);
    writeDesktopState(paths.desktop, { ...readDesktopState(paths.desktop)!, ownerPassword: hashPassword('a different owner password') });
    const newer = backupNow(paths, stick, AT + 1000);
    const oldComputer = desktopPaths(scratch('older-recovery-'));
    expect(() => restoreBackup(oldComputer, older, 'a different owner password', AT)).toThrow(/κωδικός/);
    restoreBackup(oldComputer, older, 'a long owner password', AT);
    const newComputer = desktopPaths(scratch('newer-recovery-'));
    expect(() => restoreBackup(newComputer, newer, 'a long owner password', AT)).toThrow(/κωδικός/);
    restoreBackup(newComputer, newer, 'a different owner password', AT);
    expect(readDesktopState(newComputer.desktop)?.ownerPassword).toBe(readDesktopState(paths.desktop)?.ownerPassword);
  });

  it('missing settings or owner access makes the backup fail, keeping every older complete backup', () => {
    const paths = installation();
    const stick = scratch('usb-');
    backupNow(paths, stick, AT);
    rmSync(paths.settings);
    expect(() => backupNow(paths, stick, AT + 1000)).toThrow();
    expect(readdirSync(join(stick, BACKUPS))).toEqual(['karta-20261021T220000']);
  });

  it('refuses a pre-existing record directory, including a link, instead of copying a recovery through it', () => {
    const target = backupNow(installation(), scratch('usb-'), AT);
    const fresh = desktopPaths(scratch('new-computer-'));
    const elsewhere = scratch('elsewhere-');
    symlinkSync(elsewhere, join(fresh.root, 'stamp'), 'junction');
    expect(() => restoreBackup(fresh, target, 'a long owner password', AT)).toThrow(/άδει/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readdirSync(fresh.root)).toEqual(['stamp']);
  });
});

describe('desktop.json', () => {
  it('a field a later version wrote is kept when this version rewrites the file (after a rollback, say)', () => {
    const paths = desktopPaths(scratch('state-'));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.desktop, JSON.stringify({ ownerPassword: 'scrypt$test', nightUpdates: true, later: { kept: true } }));
    writeDesktopState(paths.desktop, { ...readDesktopState(paths.desktop)!, backupFolder: '/somewhere' });
    expect(JSON.parse(readFileSync(paths.desktop, 'utf8'))).toMatchObject({ later: { kept: true }, backupFolder: '/somewhere' });
  });
});

describe('the stores, once made', () => {
  it('⛔ a store missing after the first start is a lost record: refused, never made again empty', () => {
    const paths = desktopPaths(scratch('lost-'));
    expect(() => ensureStores(paths, {}, new Date(AT).toISOString(), true)).toThrow(/λείπει το αρχείο .*stamp\.sqlite.*αντίγραφο/);
  });

  it('…and the page it shows says how to restore it: which file, from which backup folder, into which folder, then a restart', () => {
    const paths = desktopPaths(scratch('lost-'));
    mkdirSync(paths.root, { recursive: true });
    const stick = scratch('usb-');
    writeDesktopState(paths.desktop, { ownerPassword: 'scrypt$test', nightUpdates: true, backupFolder: stick });
    let thrown: unknown;
    try {
      ensureStores(paths, {}, new Date(AT).toISOString(), true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreMissing);
    const steps = String(restoreSteps(paths, (thrown as StoreMissing).missing));
    expect(steps).toContain(join(stick, BACKUPS));
    expect(steps).toContain('Πρώτη ρύθμιση');
    expect(steps).toContain('Μην αντιγράψετε μόνο');
    expect(steps).toContain(paths.root);
    expect(steps).toContain('επανεκκινήστε τον υπολογιστή');
    expect(steps).toContain('δείτε πρώτα στην ΕΡΓΑΝΗ'); // a card sent after the backup must not be filed twice
    expect(steps).not.toContain('«Αντίγραφα»'); // a page that is not served in this state
  });
});
