// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEmployerConfig } from '../src/config.js';
import { ensureStores } from '../src/desktop/main.js';
import { ownerPages } from '../src/desktop/owner/pages.js';
import { createOwnerServer, saveSetup } from '../src/desktop/owner/server.js';
import { desktopPaths } from '../src/desktop/paths.js';
import { parseSettings, serviceEnv } from '../src/desktop/settings-file.js';
import { readDesktopState } from '../src/desktop/state.js';
import { capturePunch } from '../src/stamp/capture.js';
import { filingClient } from '../src/stamp/deadline.js';
import { Outbox, stateOfPunch } from '../src/stamp/outbox.js';
import { ENARXI, LIXI } from '../src/ergani/types.js';
import { checkPin, chooseOwnPin, personByAfm } from '../src/stamp/staff.js';
import { openStampStore, storeBranches } from '../src/stamp/store.js';
import { startErganiFake } from './fake/ergani-fake.js';
import { AFM, ALFA } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function fixture(running = false) {
  const now = Date.parse('2026-10-26T10:00:00+02:00');
  const fake = await startErganiFake({ now: () => now, employerAfm: AFM.employer, branchLogins: {
    '0': { username: 'fixture01', password: 'Fixture.p1' },
    '1': { username: 'fixture02', password: 'Fixture.p2' },
  } });
  cleanup.push(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), 'karta-settings-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = desktopPaths(dir);
  saveSetup(paths, { ownerPassword: 'original owner password', alerts: false, rows: 1, ownProblems: [], answers: {
    instance: 'fixture', label: 'Ιατρείο Δοκιμής', employerAfm: AFM.employer, realm: 'trial',
    branches: [{ code: '0', label: 'Κέντρο', username: 'fixture01', password: 'Fixture.p1', inspectorateEmail: '', schedule: 'none' }],
    bindAddress: '127.0.0.1', port: 8880, cookieSecure: false, ntfyUrl: '', ntfyToken: '', stampHeartbeatUrl: '', archiveHeartbeatUrl: '', archiveFrom: '2026-10',
  } }, new Date(now).toISOString());
  const env = serviceEnv(paths, { ERGANI_BASE_URL: fake.baseUrl });
  ensureStores(paths, env, new Date(now).toISOString(), false);
  const db = openStampStore(paths.stampDb, { name: 'fixture', realm: 'local', employerAfm: AFM.employer });
  cleanup.push(() => db.close());
  let origin: string;
  if (running) {
    const listener = createNetServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    // Give the staff server its own unused port as well.
    const staffListener = createNetServer();
    await new Promise<void>((resolve) => staffListener.listen(0, '127.0.0.1', resolve));
    const staffPort = (staffListener.address() as { port: number }).port;
    await new Promise<void>((resolve) => staffListener.close(() => resolve()));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(paths.settings, readFileSync(paths.settings, 'utf8').replace('ERGANI_PORT=8880', `ERGANI_PORT=${staffPort}`), { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'desktop', '--no-open'], {
      env: { PATH: process.env.PATH, KARTA_DATA_DIR: dir, KARTA_OWNER_PORT: String(port), ERGANI_BASE_URL: fake.baseUrl }, stdio: 'ignore',
    });
    const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    cleanup.push(async () => { child.kill('SIGTERM'); await ended; });
    origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${staffPort}/health`).then((r) => r.ok, () => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('desktop did not start');
  } else {
  const pages = ownerPages({ paths, env, now: () => now, log: () => {}, erganiSilentSince: () => undefined,
    reloadSettings: async () => { Object.assign(env, serviceEnv(paths, { ERGANI_BASE_URL: fake.baseUrl })); },
  });
  const server = createOwnerServer({ paths, now: () => now, log: () => {}, onSetup: async () => {}, pages: () => pages, guide: '', mark: '' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  let cookie = '';
  let csrf = '';
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' });
  const post = (fields: Record<string, string>, path = '/settings') => fetch(`${origin}${path}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields }), redirect: 'manual',
  });
  const login = async (password: string) => {
    const response = await post({ password }, '/login');
    if (response.status === 303) { cookie = response.headers.get('set-cookie')!.split(';')[0]!; csrf = /name="csrf" value="([^"]+)"/.exec(await (await get('/')).text())![1]!; }
    return response;
  };
  await login('original owner password');
  return { paths, db, fake, env, get, post, login, now };
}

describe('the owner settings', () => {
  it('corrects the practice name as a new fact and preserves unrelated settings', async () => {
    const f = await fixture();
    const response = await f.post({ do: 'practice', label: 'Ιατρείο Παραδείγματος' });
    expect(response.status).toBe(200);
    const values = parseSettings(readFileSync(f.paths.settings, 'utf8'));
    expect(values.STAMP_LABEL).toBe('Ιατρείο Παραδείγματος');
    expect(values.ERGANI_BRANCH_0_PASSWORD).toBe('Fixture.p1');
    expect(values.COMPOSE_PROJECT_NAME).toBe('ergani-fixture');
    expect(f.db.prepare("SELECT detail FROM settings_events WHERE kind = 'practice-renamed'").get()?.detail).toContain('Ιατρείο Δοκιμής');
    expect(statSync(f.paths.settings).mode & 0o777).toBe(0o600);
  });

  it('changes a branch login, runs a read-only connection check and never echoes either password', async () => {
    const f = await fixture();
    const response = await f.post({ do: 'connection', branch: '0', username: 'fixture02', password: 'Fixture.p2', password2: 'Fixture.p2' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('WRKCardSE');
    expect(body).not.toContain('Fixture.p2');
    expect(body).not.toContain('Fixture.p1');
    const config = loadEmployerConfig(serviceEnv(f.paths, { ERGANI_BASE_URL: f.fake.baseUrl }));
    expect(config.branches[0]!.erganiUsername).toBe('fixture02');
    expect(f.fake.requests.some((r) => r.route === 'Lookup/Submissions')).toBe(true);
    expect(f.fake.requests.some((r) => r.route === 'Submissions')).toBe(false);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM settings_events').all())).not.toContain('Fixture.p2');
  });

  it('keeps a failed new login repairable and does not expose its password', async () => {
    const f = await fixture();
    const response = await f.post({ do: 'connection', branch: '0', username: 'fixture09', password: 'Wrong.p999', password2: 'Wrong.p999' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('απέτυχε');
    expect(body).not.toContain('Wrong.p999');
    expect((await f.get('/settings')).status).toBe(200);
  });

  it('requires the old owner password, then rejects all sessions created with the old password', async () => {
    const f = await fixture();
    const oldHash = readDesktopState(f.paths.desktop)!.ownerPassword;
    const wrong = await f.post({ do: 'password', old: 'wrong owner password', password: 'replacement owner password', password2: 'replacement owner password' });
    expect(wrong.status).toBe(200);
    expect(readDesktopState(f.paths.desktop)!.ownerPassword).toBe(oldHash);
    const changed = await f.post({ do: 'password', old: 'original owner password', password: 'replacement owner password', password2: 'replacement owner password' });
    expect(changed.status).toBe(303);
    expect((await f.get('/settings')).headers.get('location')).toBe('/login');
    expect((await f.login('original owner password')).status).toBe(401);
    expect((await f.login('replacement owner password')).status).toBe(303);
    expect(readFileSync(f.paths.desktop, 'utf8')).not.toContain('replacement owner password');
  }, 15_000);

  it('limits guesses of the old owner password and refuses mismatched connection passwords without changing anything', async () => {
    const f = await fixture();
    const original = readFileSync(f.paths.settings, 'utf8');
    const refused = await f.post({ do: 'connection', branch: '0', username: 'fixture02', password: 'Fixture.p2', password2: 'Fixture.p1' });
    expect(await refused.text()).toContain('διαφέρουν');
    expect(readFileSync(f.paths.settings, 'utf8')).toBe(original);
    for (let i = 0; i < 5; i++) await f.post({ do: 'password', old: 'wrong owner password', password: 'replacement owner password', password2: 'replacement owner password' });
    const locked = await f.post({ do: 'password', old: 'original owner password', password: 'replacement owner password', password2: 'replacement owner password' });
    expect(await locked.text()).toContain('Πολλοί λάθος');
    expect((await f.login('original owner password')).status).toBe(303);
  }, 15_000);

  it('adds, renames and retires a branch with a card without losing its history or pending sends', async () => {
    const f = await fixture();
    expect((await f.post({ do: 'add-branch', branch: '1', label: 'Δεύτερο', username: 'fixture02', password: 'Fixture.p2', password2: 'Fixture.p2', schedule: 'none' })).status).toBe(200);
    expect(storeBranches(f.db)).toEqual(['0', '1']);
    expect((await f.post({ do: 'branch-name', branch: '1', label: 'Παράδειγμα' })).status).toBe(200);
    const added = await addPersonForTest(f.db, ALFA, 'fixture', f.now);
    const checked = await checkPin(f.db, added.id, added.oneTimePin!, f.now);
    if (checked.kind !== 'ok') throw new Error('fixture PIN');
    const own = await chooseOwnPin(f.db, checked.person, '2580', f.now);
    if (!own.ok) throw new Error('fixture own PIN');
    const device = deviceAt(f.db, '1');
    const card = capturePunch(f.db, own.person, ENARXI, device, f.now);
    expect((await f.post({ do: 'retire-branch', branch: '1' })).status).toBe(200);
    expect(storeBranches(f.db)).toEqual(['0', '1']);
    expect(f.db.prepare('SELECT * FROM punches WHERE id = ?').get(card.id)?.branch).toBe('1');
    expect(loadEmployerConfig(serviceEnv(f.paths, { ERGANI_BASE_URL: f.fake.baseUrl })).branches.map((b) => b.branchCode)).toEqual(['0', '1']);
    expect(() => capturePunch(f.db, own.person, LIXI, device, f.now + 60_000)).toThrow(/retired|λειτουργ/);
    expect(() => f.db.prepare('UPDATE settings_events SET detail = ?').run('changed')).toThrow();
    expect(() => f.db.prepare('DELETE FROM settings_events').run()).toThrow();
    const body = await (await f.get('/settings')).text();
    expect(body).toContain('Παράδειγμα');
    expect(body).toContain('αποσυρθεί');
    const config = loadEmployerConfig(serviceEnv(f.paths, { ERGANI_BASE_URL: f.fake.baseUrl }));
    const outbox = new Outbox({ db: f.db, clients: new Map(config.branches.map((b) => [b.branchCode, filingClient(b, () => f.now)])), employerAfm: AFM.employer, now: () => f.now, log: () => {} });
    await outbox.pass();
    expect(stateOfPunch(f.db, card, f.now).kind).toBe('filed');
    expect(f.fake.filed).toHaveLength(1);
  });

  it('corrects an employee name for future cards, leaving the original card and the correction recorded', async () => {
    const f = await fixture();
    const added = await addPersonForTest(f.db, ALFA, 'fixture', f.now);
    const checked = await checkPin(f.db, added.id, added.oneTimePin!, f.now);
    if (checked.kind !== 'ok') throw new Error('fixture PIN');
    const own = await chooseOwnPin(f.db, checked.person, '2580', f.now);
    if (!own.ok) throw new Error('fixture own PIN');
    const card = capturePunch(f.db, own.person, ENARXI, deviceAt(f.db), f.now);
    const changed = await f.post({ do: 'employee', afm: ALFA.afm, surname: 'Δοκιμή', first: 'Βήτα', display: 'Βήτα' });
    expect(changed.status).toBe(200);
    expect(personByAfm(f.db, ALFA.afm).firstName).toBe('ΒΗΤΑ');
    expect(f.db.prepare('SELECT surname, first_name FROM punches WHERE id = ?').get(card.id)).toEqual({ surname: 'ΠΑΡΑΔΕΙΓΜΑ', first_name: 'ΑΛΦΑ' });
    expect(f.db.prepare("SELECT count(*) AS n FROM employee_events WHERE kind = 'renamed'").get()?.n).toBe(1);
    await f.post({ do: 'employee', afm: ALFA.afm, surname: '', first: 'Βήτα', display: 'Βήτα' });
    expect(personByAfm(f.db, ALFA.afm).surname).toBe('ΔΟΚΙΜΗ');
  });

  it('applies names, logins and new branches to the running staff service without a computer restart', async () => {
    const f = await fixture(true);
    const staffOrigin = `http://127.0.0.1:${parseSettings(readFileSync(f.paths.settings, 'utf8')).ERGANI_PORT}`;
    const enrolled = await f.post({ do: 'enroll', branch: '0', label: 'Δοκιμή' }, '/devices');
    const link = /(http:[^<> ]+\/enroll\/[A-Za-z0-9_-]+)/.exec(await enrolled.text())![1]!;
    const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const board = () => fetch(`${staffOrigin}/api/board`, { headers: { cookie } }).then((r) => r.json() as Promise<{ label: string }>);
    await f.post({ do: 'practice', label: 'Ιατρείο Παραδείγματος' });
    expect((await board()).label).toBe('Ιατρείο Παραδείγματος');
    await f.post({ do: 'connection', branch: '0', username: 'fixture09', password: 'Wrong.p999', password2: 'Wrong.p999' });
    expect((await f.get('/settings')).status).toBe(200);
    const repair = await f.post({ do: 'connection', branch: '0', username: 'fixture01', password: 'Fixture.p1', password2: 'Fixture.p1' });
    expect(await repair.text()).toContain('WRKCardSE');
    const added = await f.post({ do: 'add-branch', branch: '1', label: 'Δεύτερο', username: 'fixture02', password: 'Fixture.p2', password2: 'Fixture.p2', schedule: 'none' });
    expect(await added.text()).toContain('Το παράρτημα προστέθηκε');
    expect((await board()).label).toBe('Ιατρείο Παραδείγματος — Κέντρο');
    const newDevice = await f.post({ do: 'enroll', branch: '1', label: 'Δοκιμή' }, '/devices');
    const newLink = /(http:[^<> ]+\/enroll\/[A-Za-z0-9_-]+)/.exec(await newDevice.text())![1]!;
    const newCookie = (await fetch(newLink, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${staffOrigin}/api/board`, { headers: { cookie: newCookie } }).then((r) => r.json() as Promise<{ label: string }>)).label).toBe('Ιατρείο Παραδείγματος — Δεύτερο');
    await f.post({ do: 'retire-branch', branch: '1' });
    const retired = await fetch(`${staffOrigin}/`, { headers: { cookie: newCookie } });
    expect(retired.status).toBe(403);
    expect(await retired.text()).toContain('αποσυρθεί');
  }, 30_000);

  it('recovers a new branch if the computer stopped between saving its settings and recording the branch', async () => {
    const f = await fixture();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(f.paths.settings, '\nERGANI_BRANCHES=0,1\nERGANI_BRANCH_1_USERNAME=fixture02\nERGANI_BRANCH_1_PASSWORD=Fixture.p2\nSTAMP_BRANCH_1_LABEL=Δεύτερο\nSTAMP_BRANCH_1_SCHEDULE=none\n');
    ensureStores(f.paths, serviceEnv(f.paths, { ERGANI_BASE_URL: f.fake.baseUrl }), new Date(f.now).toISOString(), true);
    expect(storeBranches(f.db)).toEqual(['0', '1']);
    expect(f.db.prepare("SELECT count(*) AS n FROM settings_events WHERE kind = 'branch-added'").get()?.n).toBe(1);
  });

  it('refuses settings without an owner session or without its CSRF token', async () => {
    const f = await fixture();
    expect((await f.post({ do: 'practice', label: 'Αλλαγή', csrf: '' })).status).toBe(403);
    await f.post({}, '/logout');
    expect((await f.post({ do: 'practice', label: 'Αλλαγή' })).headers.get('location')).toBe('/login');
    expect(parseSettings(readFileSync(f.paths.settings, 'utf8')).STAMP_LABEL).toBe('Ιατρείο Δοκιμής');
  });
});
