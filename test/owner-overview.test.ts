// SPDX-License-Identifier: EUPL-1.2
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerPages } from '../src/desktop/owner/pages.js';
import { readOverviewMaintenance } from '../src/desktop/owner/overview-maintenance.js';
import { backupAndRecord } from '../src/desktop/backup.js';
import { hashPassword } from '../src/desktop/owner/auth.js';
import { desktopPaths } from '../src/desktop/paths.js';
import { readDesktopState, writeDesktopState } from '../src/desktop/state.js';
import { ENARXI, LIXI } from '../src/ergani/types.js';
import { claimRecordStore, openRecordStore } from '../src/records/store.js';
import { recordArchiveStatus } from '../src/records/status.js';
import { athensInstant } from '../src/stamp/athens.js';
import { capturePunch } from '../src/stamp/capture.js';
import { decide } from '../src/stamp/outbox.js';
import { checkPin, chooseOwnPin, type VerifiedPerson } from '../src/stamp/staff.js';
import { initStampStore, type StampStore } from '../src/stamp/store.js';
import { AFM, ALFA, VITA } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';
import { startErganiFake } from './fake/ergani-fake.js';

let dirs: string[] = [];
let stores: StampStore[] = [];
afterEach(() => {
  for (const db of stores) if (db.isOpen) db.close();
  stores = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function installation(at = athensInstant('2026-10-26', '10:00'), baseUrl = 'http://127.0.0.1:1/') {
  const root = mkdtempSync(join(tmpdir(), 'karta-overview-'));
  dirs.push(root);
  const paths = desktopPaths(root);
  mkdirSync(dirname(paths.stampDb), { recursive: true });
  mkdirSync(dirname(paths.recordsDb), { recursive: true });
  const db = initStampStore(paths.stampDb, { name: 'testclinic', realm: 'local', employerAfm: AFM.employer }, ['0', '1'], 'now');
  stores.push(db);
  const records = openRecordStore(paths.recordsDb);
  claimRecordStore(records, AFM.employer, 'now');
  stores.push(records);
  writeDesktopState(paths.desktop, { ownerPassword: 'scrypt$fixture', nightUpdates: true });
  const env = {
    ERGANI_BASE_URL: baseUrl, ERGANI_EMPLOYER_AFM: AFM.employer, ERGANI_USERTYPE: '02',
    ERGANI_BRANCHES: '0,1', ERGANI_BRANCH_0_USERNAME: 'fixture01', ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
    ERGANI_BRANCH_1_USERNAME: 'fixture02', ERGANI_BRANCH_1_PASSWORD: 'Fixture.p2',
    STAMP_DB: paths.stampDb, STAMP_INSTANCE: 'testclinic', STAMP_LABEL: 'Οδοντιατρείο Δοκιμής',
    STAMP_BRANCH_0_LABEL: 'Έδρα', STAMP_BRANCH_1_LABEL: 'Δεύτερο', ARCHIVE_FROM: '2026-09',
  };
  let clock = at;
  let silent: number | undefined;
  let archiveFailed = false;
  const maintenance = () => readOverviewMaintenance({ paths, nowMs: clock, archiveFrom: env.ARCHIVE_FROM, branches: ['0', '1'], employerAfm: AFM.employer, realm: 'local', archiveFailed });
  const pages = ownerPages({ paths, env, now: () => clock, log: () => undefined, erganiSilentSince: () => silent, archiveFailed: () => archiveFailed, openFolders: false });
  const render = async (path = '/') => {
    const handler = pages.get(path);
    if (handler === undefined) throw new Error(`missing page ${path}`);
    const response = await handler({ method: 'GET', path, query: new URLSearchParams(), form: new URLSearchParams(), csrf: 'fixture-csrf' });
    if (!('body' in response)) throw new Error('unexpected redirect');
    return response.body;
  };
  return { paths, db, records, env, render, pages, maintenance, setClock: (t: number) => { clock = t; }, setSilent: (t: number | undefined) => { silent = t; }, setArchiveFailed: (failed: boolean) => { archiveFailed = failed; } };
}

async function verified(db: StampStore, person = ALFA): Promise<VerifiedPerson> {
  const { id, oneTimePin } = await addPersonForTest(db, person, 'test', 1);
  const checked = await checkPin(db, id, oneTimePin!, 2);
  if (checked.kind !== 'ok') throw new Error('fixture PIN refused');
  const chosen = await chooseOwnPin(db, checked.person, '2580', 3);
  if (!chosen.ok) throw new Error(chosen.problem);
  return chosen.person;
}

function filed(db: StampStore, punchId: number, atMs: number, pdf = false) {
  const attempt = db.prepare(`INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, protocol, submit_date)
    VALUES (?, ?, ?, '', 'filed', 'FIXTURE', '26/10/2026 10:00') RETURNING id`).get(punchId, atMs, atMs);
  if (pdf) db.prepare('INSERT INTO evidence (attempt_id, at_ms, pdf, sha256) VALUES (?, ?, ?, ?)').run(Number(attempt?.['id']), atMs, Buffer.from('%PDF-fixture'), 'fixture');
}

function pull(records: StampStore, month: string, branch: string, outcome: 'complete' | 'stopped', atIso: string) {
  records.prepare(`INSERT INTO pulls (month, realm, branch, started_at, finished_at, outcome, stamp_rows, schedule_rows,
    new_stamp_rows, new_schedule_rows, stamps_no_longer_answered, schedule_no_longer_answered)
    VALUES (?, 'local', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`).run(month, branch, atIso, atIso, outcome);
}

describe('the owner’s first screen', () => {
  it('reads ready’s complete backup outcomes through the maintenance seam on each refresh', async () => {
    const t = installation();
    writeDesktopState(t.paths.desktop, { ...readDesktopState(t.paths.desktop)!, ownerPassword: hashPassword('a long owner password') });
    writeFileSync(t.paths.settings, 'ERGANI_BRANCH_0_PASSWORD=Fixture.p1\n', { mode: 0o600 });
    const stick = join(t.paths.root, 'usb');
    mkdirSync(stick);
    writeDesktopState(t.paths.desktop, { ...readDesktopState(t.paths.desktop)!, backupFolder: stick });
    const at = athensInstant('2026-10-26', '10:00');
    expect(backupAndRecord(t.paths, at, () => undefined).ok).toBe(true);
    expect(t.maintenance().backup).toEqual({ atIso: new Date(at).toISOString(), ok: true });
    expect(await t.render()).toContain('Τελευταίο αντίγραφο:');
    renameSync(stick, stick + '-unplugged');
    expect(backupAndRecord(t.paths, at + 1, () => undefined).ok).toBe(false);
    expect(t.maintenance().backup?.ok).toBe(false);
    expect(await t.render()).toMatch(/Το τελευταίο αντίγραφο απέτυχε[\s\S]*USB/);
  });

  it('joins daily archive status through the seam: a later failed run and page failure cannot hide its last good run', async () => {
    const t = installation();
    pull(t.records, '2026-09', '0', 'complete', '2026-10-26T07:00:00Z');
    recordArchiveStatus(t.paths.recordsDb, { kind: 'up' }, Date.parse('2026-10-24T01:15:00Z'));
    recordArchiveStatus(t.paths.recordsDb, { kind: 'failed', incomplete: [{ month: '2026-09', branch: '1' }], pages: ['2026-09'] }, Date.parse('2026-10-26T07:00:00Z'));
    expect(t.maintenance().archive.run).toMatchObject({ kind: 'failed', lastGood: '2026-10-24T01:15:00.000Z', pages: ['2026-09'] });
    const home = await t.render();
    for (const id of ['submissions', 'proofs', 'connection', 'backup', 'archive']) expect(home).toContain(`id="${id}"`);
    expect(home).toContain('Τελευταίο πλήρες μηνιαίο αρχείο');
    expect(home).toContain('πάνω από 36 ώρες');
    expect(home).toContain('Ο τελευταίος έλεγχος του μηνιαίου αρχείου απέτυχε');
    expect(home).toContain('Σελίδες που δεν γράφτηκαν: 2026-09');
    expect(home).toContain('2026-09 — Οδοντιατρείο Δοκιμής — Δεύτερο');
    expect(home).not.toContain('Δεν υπάρχει ακόμη εδώ αποτέλεσμα ολόκληρης');
  });

  it('keeps expired archive gaps visible and shows a runtime failure when its durable status cannot be saved', async () => {
    const t = installation();
    t.env.ARCHIVE_FROM = '2026-04';
    recordArchiveStatus(t.paths.recordsDb, { kind: 'up' }, athensInstant('2026-10-26', '03:15'));
    t.setArchiveFailed(true);
    const home = await t.render();
    expect(home).toContain('2026-04 — Οδοντιατρείο Δοκιμής — Έδρα');
    expect(home).toContain('2026-04 — Οδοντιατρείο Δοκιμής — Δεύτερο');
    expect(home).toContain('Ο τελευταίος έλεγχος του μηνιαίου αρχείου απέτυχε');
    expect(home).toContain('Τελευταίο πλήρες μηνιαίο αρχείο');
  });

  it('shows all five status areas and their next action without making any network request', async () => {
    // A missing area, or a GET that starts the connection check, breaks this first-screen contract.
    const fake = await startErganiFake({ employerAfm: AFM.employer });
    const { render } = installation(undefined, fake.baseUrl);
    let home: string;
    try {
      home = await render();
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
    for (const id of ['submissions', 'proofs', 'connection', 'backup', 'archive']) expect(home).toContain(`id="${id}"`);
    for (const action of ['/queue', '/queue#proofs', '/check', '/backup']) expect(home).toContain(`href="${action}"`);
    expect(home).toContain('Δεν έχει γίνει ακόμη αντίγραφο');
    expect(home).toContain('2026-09');
    expect(home).not.toContain('Fixture.p1');
    expect(home).not.toContain('fixture01');
    expect(home).not.toContain('scrypt$fixture');
  });

  it('counts today by Athens stamp time across midnight, keeps earlier decisions visible, and removes resolved cards', async () => {
    // UTC dates and reference_date both misclassify this overnight exit; yesterday’s queue must remain visible.
    const { db, render, setClock } = installation(athensInstant('2026-10-27', '00:20'));
    const who = await verified(db);
    const device = deviceAt(db);
    const older = capturePunch(db, who, ENARXI, device, athensInstant('2026-10-26', '23:30'));
    const today = capturePunch(db, who, LIXI, device, athensInstant('2026-10-27', '00:01'));
    expect(today.referenceDate).toBe('2026-10-26');
    let home = await render();
    expect(home).toContain('Σήμερα: 1 κάρτα/-ες χρειάζονται απόφαση.');
    expect(home).toContain('Προηγούμενες ημέρες: 1 κάρτα/-ες χρειάζονται απόφαση.');
    decide(db, older.id, { kind: 'covered' }, { employeeId: undefined, label: 'test', deviceId: undefined }, athensInstant('2026-10-27', '00:21'));
    filed(db, today.id, athensInstant('2026-10-27', '00:22'), true);
    setClock(athensInstant('2026-10-27', '00:23'));
    home = await render();
    expect(home).toContain('Καμία κάρτα δεν περιμένει απόφαση.');
    expect(home).not.toContain('Προηγούμενες ημέρες:');
  });

  it('shows a current retry problem verbatim and escaped, without presenting an unconfirmed card as filed', async () => {
    const at = athensInstant('2026-10-26', '10:00');
    const { db, render } = installation(at + 60_000);
    const card = capturePunch(db, await verified(db), ENARXI, deviceAt(db, '1'), at);
    db.prepare(`INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, http_status, message)
      VALUES (?, ?, ?, '', 'refused', 400, ?)`).run(card.id, at, at, 'Δοκιμή <script> & σφάλμα');
    const home = await render();
    expect(home).toContain('1 κάρτα/-ες με πρόβλημα στην αυτόματη αποστολή');
    expect(home).toContain('Δοκιμή &#60;script&#62; &#38; σφάλμα');
    expect(home).toContain('Δεύτερο');
    expect(home).not.toContain('<script>');
    expect(home).toContain('Η αποστολή ξαναδοκιμάζεται');
  });

  it('shows every missing PDF immediately, excludes held PDFs, and explains when automatic retrieval has stopped', async () => {
    const at = athensInstant('2026-10-26', '10:00');
    const { db, render, setClock } = installation(at);
    const device = deviceAt(db);
    const a = capturePunch(db, await verified(db), ENARXI, device, at);
    const b = capturePunch(db, await verified(db, VITA), ENARXI, device, at);
    filed(db, a.id, at);
    filed(db, b.id, at, true);
    expect(await render()).toContain('1 κάρτα/-ες στάλθηκαν χωρίς να έχει ληφθεί ακόμη το PDF.');
    const queue = await render('/queue');
    expect(queue).toContain('id="proofs"');
    expect(queue).toContain('Άλφα');
    expect(queue).not.toContain('Βήτα');
    setClock(at + 184 * 86_400_000);
    expect(await render('/queue')).toContain('Η αυτόματη αναζήτηση σταμάτησε');
    const attempt = Number(db.prepare('SELECT id FROM attempts WHERE punch_id = ?').get(a.id)?.['id']);
    db.prepare('INSERT INTO evidence (attempt_id, at_ms, pdf, sha256) VALUES (?, ?, ?, ?)').run(attempt, at, Buffer.from('%PDF-fixture'), 'fixture');
    expect(await render()).toContain('Δεν λείπει απόδειξη PDF');
  });

  it('describes the reachability monitor’s limited evidence in both states', async () => {
    const { render, setSilent } = installation();
    const unknown = await render();
    expect(unknown).toContain('Δεν έχει παρατηρηθεί διακοπή 10 λεπτών');
    expect(unknown).toContain('δεν επιβεβαιώνει τον κωδικό ή τα δικαιώματα');
    expect(unknown).not.toContain('αν του επιτρέπεται η δήλωση κάρτας');
    setSilent(athensInstant('2026-10-26', '09:00'));
    const down = await render();
    expect(down).toContain('δεν φτάνει την ΕΡΓΑΝΗ');
    expect(down).toContain('Επιθεώρηση Εργασίας');
    expect(down).toContain('href="/check"');
  });

  it('reads backup changes on each refresh and gives a failed or old backup a repair action', async () => {
    const { paths, render } = installation();
    const state = readDesktopState(paths.desktop)!;
    writeDesktopState(paths.desktop, { ...state, lastBackup: { atIso: '2026-10-26T07:00:00Z', ok: false, problem: 'USB <λείπει>' } });
    let home = await render();
    expect(home).toMatch(/Το τελευταίο αντίγραφο απέτυχε[\s\S]*USB &#60;λείπει&#62;[\s\S]*href="\/backup"/);
    writeDesktopState(paths.desktop, { ...state, lastBackup: { atIso: '2026-10-24T07:00:00Z', ok: true } });
    home = await render();
    expect(home).toContain('Πέρασε μία ημέρα χωρίς νέο επιτυχημένο αντίγραφο');
  });

  it('shows the last complete monthly read and every missing branch, even after a newer failure', async () => {
    const { records, render } = installation();
    pull(records, '2026-09', '0', 'complete', '2026-10-24T07:00:00Z');
    pull(records, '2026-09', '0', 'stopped', '2026-10-25T07:00:00Z');
    const home = await render();
    expect(home).toContain('Τελευταία πλήρης ανάγνωση');
    expect(home).toContain('2026-09 — Οδοντιατρείο Δοκιμής — Έδρα');
    expect(home).toContain('2026-09 — Οδοντιατρείο Δοκιμής — Δεύτερο');
    expect(home).toContain('Η τελευταία ανάγνωση δεν ολοκληρώθηκε');
    expect(home).toContain('Δεν έχει ολοκληρωθεί ανάγνωση');
  });

  it('keeps the home page usable when the archive cannot be read, and does not recreate a missing store', async () => {
    const { records, paths, render } = installation();
    records.close();
    rmSync(paths.recordsDb);
    const home = await render();
    expect(home).toContain('Δεν διαβάστηκε η κατάσταση του μηνιαίου αρχείου');
    expect(existsSync(paths.recordsDb)).toBe(false);
    expect(home).toContain('id="submissions"');
  });
});
