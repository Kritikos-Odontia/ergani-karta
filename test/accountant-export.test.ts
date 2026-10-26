// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountantFiles, writeAccountantExport } from '../src/export/accountant.js';
import { afterEach, expect, it } from 'vitest';
import { createOwnerServer } from '../src/desktop/owner/server.js';
import { hashPassword } from '../src/desktop/owner/auth.js';
import { writeDesktopState } from '../src/desktop/state.js';
import { ownerPages } from '../src/desktop/owner/pages.js';
import { desktopPaths } from '../src/desktop/paths.js';
import { openRecordStore, claimRecordStore } from '../src/records/store.js';
import { initStampStore } from '../src/stamp/store.js';
import { capturePunch } from '../src/stamp/capture.js';
import { checkPin, chooseOwnPin } from '../src/stamp/staff.js';
import { athensInstant } from '../src/stamp/athens.js';
import { ALFA, VITA, AFM } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.reverse()) await f(); cleanup = []; });

// Read a ZIP independently of the exporter, using the local entry records and its central-directory boundary.
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let pos = 0;
  while (bytes.readUInt32LE(pos) === 0x04034b50) {
    expect(bytes.readUInt16LE(pos + 8)).toBe(0); // portable stored entries
    const size = bytes.readUInt32LE(pos + 18);
    const length = bytes.readUInt16LE(pos + 26);
    const extra = bytes.readUInt16LE(pos + 28);
    const name = bytes.subarray(pos + 30, pos + 30 + length).toString('utf8');
    const start = pos + 30 + length + extra;
    files.set(name, bytes.subarray(start, start + size));
    pos = start + size;
  }
  expect(bytes.readUInt32LE(pos)).toBe(0x02014b50);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(bytes.length - 12)).toBe(files.size);
  return files;
}

async function setup({ archive = true, wrongEmployer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ergani-accountant-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = desktopPaths(root);
  mkdirSync(dirname(paths.stampDb), { recursive: true });
  const db = initStampStore(paths.stampDb, { name: 'testclinic', realm: 'local', employerAfm: AFM.employer }, ['0'], 'x');
  cleanup.push(() => db.close());
  const added = await addPersonForTest(db, ALFA, 'test', athensInstant('2026-09-30', '07:00'));
  const pin = await checkPin(db, added.id, added.oneTimePin!, athensInstant('2026-09-30', '07:00'));
  if (pin.kind !== 'ok') throw new Error('PIN');
  const chosen = await chooseOwnPin(db, pin.person, '2580', athensInstant('2026-09-30', '07:00'));
  if (!chosen.ok) throw new Error(chosen.problem);
  const device = deviceAt(db);
  const start = capturePunch(db, chosen.person, '0', device, athensInstant('2026-09-30', '22:00'));
  const end = capturePunch(db, chosen.person, '1', device, athensInstant('2026-10-01', '02:00'));
  // A card outside the working-day period must not leak into the file set.
  capturePunch(db, chosen.person, '0', device, athensInstant('2026-10-02', '09:00'));
  db.prepare("INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, protocol, ergani_id, submit_date) VALUES (?, ?, ?, '', 'filed', 'TEST-PROOF', 'TEST-ID', '30/09/2026 22:00')")
    .run(start.id, start.eventMs, start.eventMs);
  db.prepare('INSERT INTO evidence (attempt_id, at_ms, pdf, sha256) VALUES (1, ?, ?, ?)').run(start.eventMs, Buffer.from('%PDF-1.4\nfixture proof'), 'test-hash');
  db.prepare("INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, message, http_status) VALUES (?, ?, ?, '', 'refused', '=Δοκιμή άρνησης', 400)")
    .run(end.id, end.eventMs, end.eventMs);
  if (archive) {
    mkdirSync(dirname(paths.recordsDb), { recursive: true });
    const record = openRecordStore(paths.recordsDb);
    claimRecordStore(record, wrongEmployer ? AFM.otherEmployer : AFM.employer, 'x');
    for (const id of [1, 2]) {
      record.prepare("INSERT INTO pulls (id, month, realm, branch, started_at, finished_at, outcome, stamp_rows, schedule_rows, new_stamp_rows, new_schedule_rows, stamps_no_longer_answered, schedule_no_longer_answered) VALUES (?, '2026-09', 'local', '0', 'x', ?, 'complete', 1, 0, 1, 0, 0, 0)").run(id, `2026-10-0${id}T07:00:00Z`);
      record.prepare("INSERT INTO day_reads (pull_id, service, day, rows) VALUES (?, 'EX_BASE_07', '2026-09-30', 1)").run(id);
    }
    for (const [id, to] of [[1, '01:00'], [2, '02:00']] as const) {
      record.prepare("INSERT INTO stamps (id, branch, day, afm, date, hour_from, hour_to, ends_next_day, first_pull_id) VALUES (?, '0', '2026-09-30', ?, '30/09/2026', '22:00', ?, 1, ?)").run(id, VITA.afm, to, id);
      record.prepare('INSERT INTO stamp_sightings (stamp_id, pull_id, copies) VALUES (?, ?, 1)').run(id, id);
    }
    record.close();
  }
  const env = { ERGANI_USERTYPE: '02', ERGANI_BASE_URL: 'http://127.0.0.1:1/api', ERGANI_EMPLOYER_AFM: AFM.employer,
    ERGANI_BRANCH_0_USERNAME: 'fixture00', ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1', STAMP_INSTANCE: 'testclinic', STAMP_DB: paths.stampDb };
  const pages = ownerPages({ paths, env, now: () => athensInstant('2026-10-26', '12:00'), log: () => undefined, erganiSilentSince: () => undefined, openFolders: false });
  const handler = pages.get('/accountant');
  const request = async (method: 'GET' | 'POST', fields: Record<string, string> = {}) => {
    expect(handler, 'the owner has an accountant export screen').toBeDefined();
    return handler!({ method, path: '/accountant', form: new URLSearchParams(fields), query: new URLSearchParams(), csrf: 'test' });
  };
  return { root, paths, db, request, pages };
}

it('makes a Greek Excel file set, submission results, unresolved cards and proof PDFs with explicit sources', async () => {
  const { paths, request } = await setup();
  const screen = await request('GET');
  expect('body' in screen && screen.body).toContain('value="2026-10"');
  const result = await request('POST', { month: '2026-09' });
  expect('body' in result && result.body).toContain('.zip');
  const folders = readdirSync(paths.exports);
  expect(folders).toHaveLength(1);
  const folder = join(paths.exports, folders[0]!);
  const zip = readdirSync(folder).find((f) => f.endsWith('.zip'))!;
  expect(zip).toBeDefined();
  if (process.platform !== 'win32') expect(statSync(join(folder, zip)).mode & 0o777).toBe(0o600);
  const files = unzip(readFileSync(join(folder, zip)));
  expect([...files.keys()]).toEqual(expect.arrayContaining(['movements.csv', 'submission-results.csv', 'unresolved.csv', 'ministry-readback.csv', 'readback-coverage.csv', 'README.txt']));
  for (const name of ['movements.csv', 'submission-results.csv', 'unresolved.csv', 'ministry-readback.csv']) {
    const bytes = files.get(name)!;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString()).toContain('sep=;\r\n');
  }
  const movements = files.get('movements.csv')!.toString();
  expect(movements).toContain('ΠΑΡΑΔΕΙΓΜΑ');
  expect(movements).toContain('2026-10-01T02:00:00+03:00');
  expect(movements).not.toContain('2026-10-02T09:00');
  expect(movements).toContain('Τοπική καταγραφή');
  expect(movements).toContain('TEST-PROOF');
  expect(files.get('submission-results.csv')!.toString()).toContain("'=Δοκιμή άρνησης");
  const unresolved = files.get('unresolved.csv')!.toString();
  expect(unresolved).toContain('ΛΗΞΗ');
  expect(unresolved).not.toContain('TEST-PROOF');
  const readback = files.get('ministry-readback.csv')!.toString();
  expect(readback).toContain(VITA.afm); // even staff who only stamped in CardScanner
  expect(readback).toContain('Επιβεβαιωμένο από τη νεότερη ανάγνωση ΕΡΓΑΝΗ');
  expect(readback).toContain('Παλαιότερη ανάγνωση — δεν επιστρέφεται πλέον');
  expect(files.get('readback-coverage.csv')!.toString()).toContain('Δεν έχει αναγνωστεί');
  const proofs = [...files].filter(([name]) => name.startsWith('proofs/'));
  expect(proofs).toHaveLength(1);
  expect(proofs[0]![1].toString()).toBe('%PDF-1.4\nfixture proof');
  const all = [...files.values()].map((b) => b.toString()).join('\n');
  for (const forbidden of ['Fixture.p1', '2580', 'pin_hash', 'settings.env', 'fixture00']) expect(all).not.toContain(forbidden);
});

it('exports local cards when the monthly store is missing and makes its absence explicit', async () => {
  const { paths, request } = await setup({ archive: false });
  const result = await request('POST', { from: '2026-09-30', to: '2026-09-30' });
  expect('body' in result && result.body).toContain('.zip');
  const folder = join(paths.exports, readdirSync(paths.exports)[0]!);
  const files = unzip(readFileSync(join(folder, readdirSync(folder).find((f) => f.endsWith('.zip'))!)));
  expect(files.get('README.txt')!.toString()).toContain('Δεν υπάρχει μηνιαίο αρχείο');
  expect(files.get('ministry-readback.csv')!.toString().split('\r\n')).toHaveLength(3); // BOM sep, heading, final newline
});

it('refuses another employer’s archive and impossible or reversed periods without creating an export', async () => {
  const { paths, request } = await setup({ wrongEmployer: true });
  for (const fields of [{ month: '2026-09' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-02', to: '2026-09-30' }]) {
    const result = await request('POST', fields);
    expect('body' in result && result.body).toContain('Δεν έγινε');
  }
  expect(() => readdirSync(paths.exports)).toThrow();
});

it('keeps both new screens behind owner sign-in and refuses export or calendar changes without CSRF', async () => {
  const { paths, pages, db } = await setup();
  writeFileSync(paths.settings, '# fabricated setup marker', { mode: 0o600 });
  writeDesktopState(paths.desktop, { ownerPassword: hashPassword('fixture owner password'), nightUpdates: false });
  const server = createOwnerServer({ paths, now: () => athensInstant('2026-10-26', '12:00'), log: () => undefined,
    onSetup: async () => undefined, pages: () => pages, guide: '', mark: '' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, fields: Record<string, string>, cookie = '') => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(fields) });
  for (const path of ['/calendar', '/accountant']) {
    expect((await fetch(base + path, { redirect: 'manual' })).headers.get('location')).toBe('/login');
    expect((await post(path, {})).headers.get('location')).toBe('/login');
  }
  expect((await post('/login', { password: 'wrong password' })).status).toBe(401);
  const signed = await post('/login', { password: 'fixture owner password' });
  const cookie = signed.headers.get('set-cookie')!.split(';')[0]!;
  for (const path of ['/calendar', '/accountant']) {
    expect((await fetch(base + path, { headers: { cookie } })).status).toBe(200);
    expect((await post(path, { month: '2026-09', do: 'quiet', from: '2026-10-28', reason: 'test' }, cookie)).status).toBe(403);
  }
  expect(() => readdirSync(paths.exports)).toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM quiet_days').get()?.['n']).toBe(0);
});

it('refuses an accountant export inside a code folder', async () => {
  const { paths, db } = await setup();
  expect(() => writeAccountantExport({ db, recordsPath: paths.recordsDb,
    out: join(fileURLToPath(new URL('../', import.meta.url)), 'accountant-exports'),
    period: { from: '2026-09-01', to: '2026-09-30' }, nowMs: athensInstant('2026-10-26', '12:00'), branchName: () => 'Έδρα' })).toThrow(/inside a code folder/);
});

it('preserves a numeric protocol as text so Excel cannot round it or remove its leading zeros', async () => {
  const { db } = await setup({ archive: false });
  // Deliberately all zeroes: a fabricated protocol, never borrowed from a filing.
  db.prepare("INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, protocol, submit_date) VALUES (2, 1, 1, '', 'filed', '00000000000000000000', '01/10/2026 02:00')").run();
  const files = accountantFiles(db, undefined, { from: '2026-09-30', to: '2026-09-30' }, athensInstant('2026-10-26', '12:00'), () => 'Έδρα');
  expect(files.get('movements.csv')!.toString()).toContain(`"'00000000000000000000"`);
  expect(files.get('submission-results.csv')!.toString()).toContain(`"'00000000000000000000"`);
});
