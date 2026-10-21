// SPDX-License-Identifier: EUPL-1.2
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startErganiFake, type ErganiFake } from './fake/ergani-fake.js';
import { AFM } from './fixtures/people.js';
import { VERSION } from '../src/version.js';

/**
 * THE DESKTOP BUILD (scripts/build.ts), as the installers carry it — built from this tree, then run from folders where
 * nothing of the source lies beside it: the program alone (setup, the stores made from the migrations it carries, the
 * staff page, the maker's mark), and the launcher running it from `versions/` as the system would.
 * ⛔ ΕΡΓΑΝΗ is the local fake; fabricated ΑΦΜ and logins.
 */
let root: string;
let built: string;
let fake: ErganiFake;
const children: ChildProcess[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'karta-bundle-'));
  built = join(root, 'built');
  const build = spawnSync(process.execPath, ['--import', 'tsx', new URL('../scripts/build.ts', import.meta.url).pathname, '--out', built], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`the build failed:\n${build.stdout}${build.stderr}`);
  fake = await startErganiFake({ now: Date.now, employerAfm: AFM.employer });
}, 60_000);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const child = spawn(command, args, { env: { PATH: process.env['PATH'], ...env }, cwd, stdio: 'ignore' });
  children.push(child);
  return child;
}

describe('the desktop build', () => {
  it('the bundle is one file that carries what it reads: run alone, it sets up, makes both stores and serves the pages', async () => {
    const alone = join(root, 'alone');
    mkdirSync(alone);
    cpSync(join(built, 'app', 'app.mjs'), join(alone, 'app.mjs'));
    expect(JSON.parse(readFileSync(join(built, 'app', 'version.json'), 'utf8')).version).toBe(VERSION);

    const data = join(root, 'data-alone');
    const [ownerPort, staffPort] = [await freePort(), await freePort()];
    run(process.execPath, [join(alone, 'app.mjs'), 'desktop', '--no-browser', '--no-open'], { KARTA_DATA_DIR: data, KARTA_OWNER_PORT: String(ownerPort), ERGANI_BASE_URL: fake.baseUrl }, alone);
    const owner = `http://127.0.0.1:${ownerPort}`;
    await until('the setup page', async () => (await fetch(`${owner}/setup`)).ok);
    const saved = await fetch(`${owner}/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: owner, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        terms: 'on', label: 'Οδοντιατρείο Δοκιμής', afm: AFM.employer, rows: '1',
        b0_code: '0', b0_label: '', b0_user: 'fixture01', b0_pass: 'Fixture.p1', b0_pass2: 'Fixture.p1', b0_email: '',
        address: '127.0.0.1', port: String(staffPort), realm: 'trial', from: new Date().toISOString().slice(0, 7),
        owner: 'a long owner password', owner2: 'a long owner password', save: '1',
      }).toString(),
    });
    expect(saved.headers.get('location')).toBe('/login');
    await until('the staff page', async () => (await fetch(`http://127.0.0.1:${staffPort}/health`)).ok);
    expect(existsSync(join(data, 'stamp', 'stamp.sqlite'))).toBe(true);
    expect(existsSync(join(data, 'records', 'records.sqlite'))).toBe(true);
    const mark = await fetch(`http://127.0.0.1:${staffPort}/odontia-mark.svg`);
    expect(mark.headers.get('content-type')).toBe('image/svg+xml');
    expect(await mark.text()).toContain('<svg');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('the launcher puts the installer’s version in place and runs it; stopping it stops the program', async () => {
    const install = join(root, 'install');
    cpSync(built, install, { recursive: true });
    const runtime = join(install, 'node');
    writeFileSync(runtime, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(runtime, 0o755);
    const data = join(root, 'data-launched');
    const ownerPort = await freePort();
    const launcher = run(runtime, [join(install, 'launcher.mjs'), 'run'], { KARTA_DATA_DIR: data, KARTA_OWNER_PORT: String(ownerPort) }, install);
    await until('the owner page under the launcher', async () => (await fetch(`http://127.0.0.1:${ownerPort}/setup`)).ok);
    expect(readFileSync(join(data, 'versions', 'current'), 'utf8').trim()).toBe(VERSION);
    expect(existsSync(join(data, 'versions', VERSION, 'app.mjs'))).toBe(true);
    expect(readFileSync(join(data, 'karta.log'), 'utf8')).toContain(`launcher: starting ${VERSION}`);
    launcher.kill('SIGTERM');
    expect(await new Promise((resolve) => launcher.once('exit', resolve))).toBe(0);
    await until('the owner page closed', async () => !(await fetch(`http://127.0.0.1:${ownerPort}/setup`).then(() => true, () => false)));
  }, 60_000);
});
