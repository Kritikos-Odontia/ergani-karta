// SPDX-License-Identifier: EUPL-1.2
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startErganiFake, type ErganiFake } from './fake/ergani-fake.js';
import { AFM } from './fixtures/people.js';
import { RELEASES_PAGE, VERSION } from '../src/version.js';
import { PORT_TAKEN } from '../src/update/versions.js';

/**
 * THE DESKTOP PROGRAM, end to end — `ergani desktop` as its own process, as on a practice's computer, with its data in
 * a scratch folder and ΕΡΓΑΝΗ played by the local fake (`ERGANI_BASE_URL`, loopback only). From an empty folder:
 * the setup page, the guards on the owner's server, sign-in, a person added, a device enrolled by its link, and a
 * restart that comes back without the setup. ⛔ Fabricated ΑΦΜ and logins; nothing leaves 127.0.0.1.
 */

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startDesktop(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'desktop', '--no-browser', '--no-open'], {
    env: { PATH: process.env['PATH'], ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  child.stdout!.on('data', (d) => void (said += String(d)));
  child.stderr!.on('data', (d) => void (said += String(d)));
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  cleanup.push(async () => {
    child.kill('SIGTERM');
    await gone;
  });
  for (let i = 0; i < 200 && !said.includes('owner pages on'); i += 1) await new Promise((r) => setTimeout(r, 50));
  if (!said.includes('owner pages on')) throw new Error(`the desktop program did not start:\n${said}`);
  return child;
}

/** A GET whose Host header says `host`, whatever address it really goes to. */
function statusWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('ergani desktop — from an empty folder to a working page', () => {
  it('sets up, guards the owner pages, signs in, adds a person, enrols a device — and comes back after a restart', async () => {
    const fake: ErganiFake = await startErganiFake({ now: Date.now, employerAfm: AFM.employer });
    cleanup.push(() => fake.close());
    const data = mkdtempSync(join(tmpdir(), 'karta-desktop-'));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    const [ownerPort, staffPort] = [await freePort(), await freePort()];
    const env = { KARTA_DATA_DIR: data, KARTA_OWNER_PORT: String(ownerPort), ERGANI_BASE_URL: fake.baseUrl };
    let desktop = await startDesktop(env);
    const owner = `http://127.0.0.1:${ownerPort}`;
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${owner}${path}`, { redirect: 'manual', headers });
    const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`${owner}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: owner, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      });

    // First run: only the setup answers.
    expect((await get('/')).headers.get('location')).toBe('/setup');
    // Browsers send the page's Origin on its forms only under a referrer policy that allows it (no-referrer ⇒
    // «Origin: null» in Chrome and Edge, refused below): the pages must say same-origin.
    expect((await get('/setup')).headers.get('referrer-policy')).toBe('same-origin');
    const setupPage = await (await get('/setup')).text();
    expect(setupPage).toContain('Πρώτη ρύθμιση');
    expect(setupPage).toContain('Φτιαγμένο από την Odontia');
    expect(setupPage).toContain('Δεν θέλετε να το φροντίζετε εσείς; <a href="https://odontia.ai">Η Odontia το τρέχει για εσάς</a>.');
    // ⛔ The guards: another name for this computer, a POST from elsewhere.
    // (fetch drops a Host header it is given, so this one goes out by node:http, which sends it as written.)
    expect(await statusWithHost(ownerPort, '/setup', `evil.example:${ownerPort}`)).toBe(421);
    expect(await statusWithHost(ownerPort, '/setup', `localhost:${ownerPort}`)).toBe(200);
    expect((await post('/setup', {}, { origin: 'http://evil.example' })).status).toBe(403);

    const answers = {
      terms: 'on', label: 'Οδοντιατρείο Δοκιμής', afm: AFM.employer, rows: '1',
      b0_code: '0', b0_label: '', b0_user: 'fixture01', b0_pass: 'Fixture.p1', b0_pass2: 'Fixture.p1', b0_email: '',
      address: '127.0.0.1', port: String(staffPort), realm: 'trial', from: new Date().toISOString().slice(0, 7),
      owner: 'a long owner password', owner2: 'a long owner password', alerts: 'on', save: '1',
    };
    // Without the terms, refused — and the passwords are not written back into the page.
    const refused = await (await post('/setup', { ...answers, terms: '' })).text();
    expect(refused).toContain('Δεν αποθηκεύτηκε');
    expect(refused).not.toContain('Fixture.p1');
    expect(refused).not.toContain('a long owner password');
    expect((await post('/setup', answers)).headers.get('location')).toBe('/login');
    expect(statSync(join(data, 'settings.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, 'desktop.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(data, 'desktop.json'), 'utf8')).not.toContain('a long owner password');
    // The setup is closed for good.
    expect((await get('/setup')).headers.get('location')).toBe('/login');

    // The services run: the staff page answers.
    await until(async () => (await fetch(`http://127.0.0.1:${staffPort}/health`)).ok, 'the staff page');

    // Sign-in.
    expect((await post('/login', { password: 'wrong password!' })).status).toBe(401);
    const signedIn = await post('/login', { password: 'a long owner password' });
    expect(signedIn.headers.get('location')).toBe('/');
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(signedIn.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    const home = await (await get('/', { cookie })).text();
    expect(home).toContain('Αρχική');
    const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1];
    expect(csrf).toBeDefined();

    // ⛔ A form without the session's CSRF token does nothing.
    const person = { do: 'add', afm: AFM.alfa, surname: 'Παράδειγμα', first: 'Άλφα', display: 'Άλφα', exempt: '' };
    expect((await post('/staff', person, { cookie })).status).toBe(403);
    const added = await (await post('/staff', { ...person, csrf: csrf! }, { cookie })).text();
    expect(added).toMatch(/Προστέθηκε «Άλφα»/);
    expect(added).toMatch(/<span class="pin">\d{4}<\/span>/);

    // A device: the one-time link, as a QR and as text, on the staff page's own address.
    const enrolled = await (await post('/devices', { do: 'enroll', label: 'Υποδοχή', csrf: csrf! }, { cookie })).text();
    expect(enrolled).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    const link = new RegExp(`http://127\\.0\\.0\\.1:${staffPort}/enroll/[A-Za-z0-9_-]+`).exec(enrolled)?.[0];
    expect(link).toBeDefined();
    const device = await fetch(link!, { redirect: 'manual' });
    expect(device.status).toBe(303);
    const deviceCookie = (device.headers.get('set-cookie') ?? '').split(';')[0]!;
    const board = (await (await fetch(`http://127.0.0.1:${staffPort}/api/board`, { headers: { cookie: deviceCookie } })).json()) as { staff: Array<{ name: string }> };
    expect(board.staff.map((p) => p.name)).toEqual(['Άλφα']);

    // A person's records: exactly the folder THIS request made — the second person exported after the first gets
    // their own, never «the newest by name» (kartes-2-… sorts after kartes-1-…).
    await post('/staff', { ...person, afm: AFM.vita, surname: 'Παράδειγμα', first: 'Βήτα', display: 'Βήτα', csrf: csrf! }, { cookie });
    const ids = [...(await (await get('/records', { cookie })).text()).matchAll(/<option value="(\d{9})">/g)].map((m) => m[1]);
    expect(ids).toEqual(expect.arrayContaining([AFM.alfa, AFM.vita]));
    await post('/records', { afm: AFM.vita, from: '', to: '', csrf: csrf! }, { cookie });
    const alfaRecords = await (await post('/records', { afm: AFM.alfa, from: '', to: '', csrf: csrf! }, { cookie })).text();
    expect(/<code>([^<]+)<\/code>/.exec(alfaRecords)?.[1]).toMatch(/[\\/]kartes-1-[^\\/]+$/);
    expect(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).storesSince).toBeDefined();

    // The easy phone alerts, ticked at setup: the page shows the QR of a random ntfy.sh topic (no ΔΟΚΙΜΗ here: it
    // would reach ntfy.sh).
    const alertsPage = await (await get('/alerts', { cookie })).text();
    const topic = /<code>(karta-[A-Za-z0-9_-]{24,})<\/code>/.exec(alertsPage)?.[1];
    expect(topic).toBeDefined();
    expect(alertsPage).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).alerts.topic).toBe(topic);
    // «Άνοιγμα» once more (an old tab, a form sent twice) keeps the topic: only «Νέο θέμα» cuts the phones off.
    await post('/alerts', { do: 'on', csrf: csrf! }, { cookie });
    expect(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).alerts.topic).toBe(topic);
    await post('/alerts', { do: 'new', csrf: csrf! }, { cookie });
    expect(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).alerts.topic).not.toBe(topic);

    // A backup to a chosen folder (a stick, the Dropbox folder) — written at once, and noted on the home page.
    const stick = mkdtempSync(join(tmpdir(), 'karta-stick-'));
    cleanup.push(() => rmSync(stick, { recursive: true, force: true }));
    const backedUp = await (await post('/backup', { do: 'folder', custom: stick, csrf: csrf! }, { cookie })).text();
    expect(backedUp).toContain('Το αντίγραφο γράφτηκε');
    expect(await (await get('/', { cookie })).text()).toContain('Τελευταίο αντίγραφο');

    // A restart: no setup, the services start by themselves, and the owner signs in again.
    desktop.kill('SIGTERM');
    await new Promise<void>((resolve) => desktop.once('exit', () => resolve()));
    desktop = await startDesktop(env);
    await until(async () => (await fetch(`http://127.0.0.1:${staffPort}/health`)).ok, 'the staff page after a restart');
    expect((await get('/', { cookie })).headers.get('location')).toBe('/login');
    expect((await get('/setup')).headers.get('location')).toBe('/login');

    // Under the launcher, just switched to this version (update/versions.ts): the probation passes once the stamping
    // service is built — «previous» is the old version, the switch is over — and the updates page shows the switch.
    desktop.kill('SIGTERM');
    await new Promise<void>((resolve) => desktop.once('exit', () => resolve()));
    const versions = join(data, 'versions');
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, 'pending.json'), JSON.stringify({ from: '0.0.1', to: VERSION, atIso: new Date().toISOString() }));
    writeFileSync(join(versions, 'current'), `${VERSION}\n`);
    desktop = await startDesktop({ ...env, KARTA_LAUNCHER: '1' });
    await until(async () => (await fetch(`http://127.0.0.1:${staffPort}/health`)).ok, 'the staff page after the switch');
    expect(existsSync(join(versions, 'pending.json'))).toBe(false);
    expect(readFileSync(join(versions, 'previous'), 'utf8').trim()).toBe('0.0.1');
    const again = (await post('/login', { password: 'a long owner password' })).headers.get('set-cookie')!.split(';')[0]!;
    const updates = await (await get('/updates', { cookie: again })).text();
    expect(updates).toContain(`Έκδοση: <strong>${VERSION}</strong>`);
    expect(updates).toMatch(/id="night" name="night" value="on" checked/);
    // A newer release on another Node.js: here (not Windows) an update like any other — the button, no installer note.
    const state = readFileSync(join(data, 'desktop.json'), 'utf8');
    writeFileSync(join(data, 'desktop.json'), JSON.stringify({ ...JSON.parse(state), update: { checkedIso: new Date().toISOString(), ok: true, available: '99.0.0', releaseNode: '99.0.0' } }), { mode: 0o600 });
    const offered = await (await get('/updates', { cookie: again })).text();
    expect(offered).toContain('Ενημέρωση τώρα</button>');
    expect(offered).not.toContain(RELEASES_PAGE);
    writeFileSync(join(data, 'desktop.json'), state, { mode: 0o600 });

    // A version that cannot start on probation ends with an error — so the launcher undoes the switch — and files
    // nothing: its staff page never opened.
    desktop.kill('SIGTERM');
    await new Promise<void>((resolve) => desktop.once('exit', () => resolve()));
    writeFileSync(join(versions, 'pending.json'), JSON.stringify({ from: '0.0.1', to: VERSION, atIso: new Date().toISOString() }));
    writeFileSync(join(data, 'settings.env'), readFileSync(join(data, 'settings.env'), 'utf8').replace(/^ERGANI_PORT=.*$/m, 'ERGANI_PORT=not-a-port'));
    desktop = await startDesktop({ ...env, KARTA_LAUNCHER: '1' });
    const code = await new Promise<number | null>((resolve) => (desktop.exitCode !== null ? resolve(desktop.exitCode) : desktop.once('exit', (c) => resolve(c))));
    expect(code).toBe(1);
    expect(existsSync(join(versions, 'pending.json'))).toBe(true);
    expect(await fetch(`http://127.0.0.1:${staffPort}/health`).then(() => 'answered', () => 'closed')).toBe('closed');
  }, 60_000);

  it('a newer version on probation where nothing is set up yet (a newer installer before the setup): it passes at once', async () => {
    const data = mkdtempSync(join(tmpdir(), 'karta-desktop-'));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    const versions = join(data, 'versions');
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, 'pending.json'), JSON.stringify({ from: '0.0.1', to: VERSION, atIso: new Date().toISOString() }));
    writeFileSync(join(versions, 'current'), `${VERSION}\n`);
    await startDesktop({ KARTA_DATA_DIR: data, KARTA_OWNER_PORT: String(await freePort()), KARTA_LAUNCHER: '1' });
    await until(async () => !existsSync(join(versions, 'pending.json')), 'the probation passed');
    expect(readFileSync(join(versions, 'previous'), 'utf8').trim()).toBe('0.0.1');
  }, 30_000);

  it('the owner’s port already taken: under the launcher it ends with PORT_TAKEN (no version to blame); on its own, with an error', async () => {
    const data = mkdtempSync(join(tmpdir(), 'karta-desktop-'));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const port = (holder.address() as { port: number }).port;
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const end = (env: NodeJS.ProcessEnv) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', cli, 'desktop', '--no-browser', '--no-open'], {
          env: { PATH: process.env['PATH'], KARTA_DATA_DIR: data, KARTA_OWNER_PORT: String(port), ...env },
          stdio: 'ignore',
        });
        child.once('exit', (code) => resolve(code));
      });
    expect(await end({ KARTA_LAUNCHER: '1' })).toBe(PORT_TAKEN);
    expect(await end({})).toBe(1);
  }, 30_000);
});
