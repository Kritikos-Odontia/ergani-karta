// SPDX-License-Identifier: EUPL-1.2
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runtimeFor } from '../src/update/launcher.js';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE LAUNCHER, as its own process — the one part that never updates (src/update/launcher.ts). Each version it runs
 * is a stand-in (fixtures/fake-version.mjs) told what to do: pass its probation, switch, fail, hang. The runtime is a
 * small wrapper around the Node.js running the tests. What is held: the installer's version placed on first start;
 * a switch that passes; a switch that fails, and one that hangs, undone with the store as it was; a version that keeps
 * stopping at start falls back once; a newer installer over an older program is a switch on probation, and an
 * installer whose version once failed is not tried again by itself; stopping the launcher stops the program; one
 * launcher per data folder; a version that finds the owner's port taken is blamed for nothing.
 */
const LAUNCHER = new URL('../src/update/launcher.ts', import.meta.url).pathname;
const FAKE = new URL('./fixtures/fake-version.mjs', import.meta.url).pathname;

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

interface World {
  data: string;
  install: string;
  runtime: string;
  versions: string;
}

/** An installed program carrying `bundled`, and an empty data folder. */
function world(bundled: string, bundledNode = '24.0.0'): World {
  const root = mkdtempSync(join(tmpdir(), 'karta-launcher-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'install');
  const data = join(root, 'data');
  mkdirSync(join(install, 'app'), { recursive: true });
  mkdirSync(data);
  const runtime = join(install, 'node');
  writeFileSync(runtime, `#!/bin/sh\nKARTA_TEST_RUNTIME="$0" exec "${process.execPath}" "$@"\n`);
  chmodSync(runtime, 0o755);
  copyFileSync(FAKE, join(install, 'app', 'app.mjs'));
  writeFileSync(join(install, 'app', 'version.json'), JSON.stringify({ version: bundled, node: bundledNode }));
  return { data, install, runtime, versions: join(data, 'versions') };
}

/** A version already in `versions/`, as an update leaves it. */
function placed(w: World, version: string, node = '22.0.0'): void {
  const dir = join(w.versions, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nKARTA_TEST_RUNTIME="$0" exec "${process.execPath}" "$@"\n`);
  chmodSync(join(dir, 'node'), 0o700);
  copyFileSync(FAKE, join(dir, 'app.mjs'));
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version, node }));
}

const behave = (w: World, version: string, what: object) => writeFileSync(join(w.data, `behave-${version}.json`), JSON.stringify(what));
const runs = (w: World) => (existsSync(join(w.data, 'runs.log')) ? readFileSync(join(w.data, 'runs.log'), 'utf8') : '');
const started = (w: World, version: string) => runs(w).split('\n').filter((l) => l.startsWith(`${version} launcher=1`)).length;
const mark = (w: World, name: string) => (existsSync(join(w.versions, name)) ? readFileSync(join(w.versions, name), 'utf8').trim() : undefined);

function store(w: World): DatabaseSync {
  mkdirSync(join(w.data, 'stamp'), { recursive: true });
  const db = new DatabaseSync(join(w.data, 'stamp', 'stamp.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  return db;
}
const rows = (w: World) => {
  const db = new DatabaseSync(join(w.data, 'stamp', 'stamp.sqlite'), { readOnly: true });
  try {
    return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>).map((r) => r.v);
  } finally {
    db.close();
  }
};

function launch(w: World, options: { probationMs?: number; portRetryMs?: number; platform?: NodeJS.Platform } = {}): { child: ChildProcess; exited: Promise<number | null>; said: () => string } {
  const code = `import(${JSON.stringify(LAUNCHER)}).then((m) => m.runLauncher({ install: ${JSON.stringify(w.install)}, runtime: ${JSON.stringify(w.runtime)}, env: process.env, probationMs: ${options.probationMs ?? 60_000}, portRetryMs: ${options.portRetryMs ?? 60_000}, platform: ${JSON.stringify(options.platform ?? process.platform)} })).then((c) => process.exit(c))`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { PATH: process.env['PATH'], KARTA_DATA_DIR: w.data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  child.stdout!.on('data', (d) => void (said += String(d)));
  child.stderr!.on('data', (d) => void (said += String(d)));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  cleanup.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  });
  return { child, exited, said: () => said };
}

async function until(what: string, test: () => boolean, ms = 15_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waited for ${what}`);
}

describe.skipIf(process.platform === 'win32')('the launcher', () => {
  it('first start: puts the installer’s version in place, runs it under the launcher, and stops it with itself', async () => {
    const w = world('0.1.0');
    behave(w, '0.1.0', { hang: true });
    const { child, exited } = launch(w);
    await until('the first run', () => runs(w).includes('0.1.0 launcher=1 args=desktop --no-browser'));
    expect(mark(w, 'current')).toBe('0.1.0');
    for (const file of ['node', 'app.mjs', 'version.json']) expect(existsSync(join(w.versions, '0.1.0', file))).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(runs(w)).toContain('0.1.0 got SIGTERM');
  }, 20_000);

  it('a switch that passes its probation: the new version runs, the old one is kept as «previous»', async () => {
    const w = world('0.1.0');
    placed(w, '0.2.0');
    behave(w, '0.1.0', { switchTo: '0.2.0' });
    behave(w, '0.2.0', { commit: true, hang: true });
    launch(w);
    await until('0.2.0 running', () => runs(w).includes('0.2.0 launcher=1'));
    await until('the probation passed', () => !existsSync(join(w.versions, 'pending.json')));
    expect(mark(w, 'current')).toBe('0.2.0');
    expect(mark(w, 'previous')).toBe('0.1.0');
    expect(runs(w).split('\n').filter((l) => l.includes('launcher=1')).map((l) => l.slice(0, 5))).toEqual(['0.1.0', '0.2.0']);
  }, 20_000);

  it('a switch whose new version fails its probation is undone: the store as it was, the old version again', async () => {
    const w = world('0.1.0');
    const db = store(w);
    db.prepare('INSERT INTO t (v) VALUES (?)').run('before');
    db.close();
    placed(w, '0.2.0');
    behave(w, '0.1.0', { switchTo: '0.2.0', then: { hang: true } });
    behave(w, '0.2.0', { writeRow: true, exit: 1 });
    launch(w);
    await until('0.1.0 again', () => runs(w).split('\n').filter((l) => l.startsWith('0.1.0 launcher=1')).length === 2);
    expect(runs(w)).toContain('0.2.0 launcher=1');
    expect(mark(w, 'current')).toBe('0.1.0');
    expect(existsSync(join(w.versions, 'pending.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.versions, 'rollback.json'), 'utf8'))).toMatchObject({ failed: '0.2.0', back: '0.1.0' });
    expect(rows(w)).toEqual(['before']); // 0.2.0's row went with it
    expect(existsSync(join(w.data, 'stamp', 'stamp.sqlite-journal'))).toBe(false);
  }, 20_000);

  it('a new version that never becomes healthy is stopped when its probation runs out, and undone', async () => {
    const w = world('0.1.0');
    store(w).close();
    placed(w, '0.2.0');
    behave(w, '0.1.0', { switchTo: '0.2.0', then: { hang: true } });
    behave(w, '0.2.0', { hang: true });
    launch(w, { probationMs: 1_500 });
    await until('0.1.0 again', () => runs(w).split('\n').filter((l) => l.startsWith('0.1.0 launcher=1')).length === 2);
    expect(runs(w)).toContain('0.2.0 got SIGTERM');
    expect(mark(w, 'current')).toBe('0.1.0');
    expect(JSON.parse(readFileSync(join(w.versions, 'rollback.json'), 'utf8'))).toMatchObject({ failed: '0.2.0', back: '0.1.0' });
  }, 20_000);

  it('a version that keeps stopping at start after its probation: back to «previous», once', async () => {
    const w = world('0.1.0');
    placed(w, '0.1.0');
    placed(w, '0.2.0');
    writeFileSync(join(w.versions, 'current'), '0.2.0\n');
    writeFileSync(join(w.versions, 'previous'), '0.1.0\n');
    behave(w, '0.2.0', { exit: 1 });
    behave(w, '0.1.0', { hang: true });
    launch(w);
    await until('0.1.0 running', () => runs(w).includes('0.1.0 launcher=1'), 20_000);
    expect(runs(w).split('\n').filter((l) => l.startsWith('0.2.0 launcher=1'))).toHaveLength(3);
    expect(mark(w, 'current')).toBe('0.1.0');
    expect(mark(w, 'previous')).toBeUndefined(); // so the two never take turns
    expect(JSON.parse(readFileSync(join(w.versions, 'rollback.json'), 'utf8'))).toMatchObject({ failed: '0.2.0', back: '0.1.0' });
  }, 30_000);

  it('a newer installer over an older program: a switch on probation, with a snapshot — like an update', async () => {
    const w = world('0.2.0');
    store(w).close();
    placed(w, '0.1.0');
    writeFileSync(join(w.versions, 'current'), '0.1.0\n');
    behave(w, '0.2.0', { commit: true, hang: true });
    launch(w);
    await until('0.2.0 running', () => runs(w).includes('0.2.0 launcher=1'));
    expect(existsSync(join(w.versions, '0.2.0', '.snapshot', 'complete'))).toBe(true);
    await until('the probation passed', () => mark(w, 'previous') === '0.1.0');
    expect(runs(w)).not.toContain('0.1.0 launcher=1');
  }, 20_000);

  it('…but an installer whose version once failed and rolled back is not tried again by itself', async () => {
    const w = world('0.2.0');
    placed(w, '0.1.0');
    writeFileSync(join(w.versions, 'current'), '0.1.0\n');
    writeFileSync(join(w.versions, 'rollback.json'), JSON.stringify({ failed: '0.2.0', back: '0.1.0', atIso: new Date().toISOString(), why: 'test' }));
    behave(w, '0.1.0', { hang: true });
    launch(w);
    await until('0.1.0 running', () => runs(w).includes('0.1.0 launcher=1'));
    expect(mark(w, 'current')).toBe('0.1.0');
    expect(existsSync(join(w.versions, '0.2.0'))).toBe(false);
  }, 20_000);

  it('a switch noted by a later version with a field this launcher does not know is still read (the launcher never updates)', async () => {
    const w = world('0.1.0');
    store(w).close();
    placed(w, '0.2.0');
    writeFileSync(join(w.versions, '0.2.0', 'version.json'), JSON.stringify({ version: '0.2.0', node: '24.0.0', later: 'a field' }));
    behave(w, '0.1.0', { switchTo: '0.2.0', pendingExtra: { later: 'a field' }, then: { hang: true } });
    behave(w, '0.2.0', { exit: 1 });
    launch(w);
    await until('0.1.0 again', () => started(w, '0.1.0') === 2);
    expect(started(w, '0.2.0')).toBe(1); // ran (its version.json whole), failed, undone
    expect(mark(w, 'current')).toBe('0.1.0');
  }, 20_000);

  it('a version made for the installed Node.js runs on the installed runtime (one path for the firewall); another on its own copy', async () => {
    const w = world('0.1.0', process.versions.node);
    placed(w, '0.2.0'); // made for another Node.js (22.0.0)
    behave(w, '0.1.0', { switchTo: '0.2.0' });
    behave(w, '0.2.0', { commit: true, hang: true });
    launch(w);
    await until('0.2.0 running', () => started(w, '0.2.0') === 1);
    const ran = runs(w).split('\n');
    // The path each ran from: the installed runtime, not 0.1.0's own copy of it; 0.2.0's own copy.
    expect(ran.find((l) => l.startsWith('0.1.0 launcher=1'))?.endsWith(`runtime=${w.runtime}`)).toBe(true);
    expect(ran.find((l) => l.startsWith('0.2.0 launcher=1'))?.endsWith(`runtime=${join(w.versions, '0.2.0', 'node')}`)).toBe(true);
    // …and each is told the INSTALLED Node.js, whatever runs it (the updater's Windows check compares with that).
    expect(ran.find((l) => l.startsWith('0.2.0 launcher=1'))).toContain(`installed=${process.versions.node} `);
  }, 20_000);

  it('runtimeFor: the installed runtime for the same Node.js — on Windows for any of its line; else the version\'s own copy, as for an unreadable version.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karta-runtime-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const o = { runtime: '/installed/node' };
    const own = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '0.3.0', node: '24.22.1' }));
    expect(runtimeFor(o, dir, '24.22.1', 'linux')).toBe('/installed/node');
    expect(runtimeFor(o, dir, '24.23.0', 'linux')).toBe(own);
    expect(runtimeFor(o, dir, '24.23.0', 'darwin')).toBe(own);
    expect(runtimeFor(o, dir, '24.23.0', 'win32')).toBe('/installed/node');
    expect(runtimeFor(o, dir, '26.0.0', 'win32')).toBe(own);
    writeFileSync(join(dir, 'version.json'), '{');
    expect(runtimeFor(o, dir, '24.22.1', 'win32')).toBe(own);
  });

  it('on Windows, going back after an installer that brought a newer Node.js of the line still runs on the installed runtime', async () => {
    // Node.js numbers no computer runs, so the test cannot pass by the launcher's own Node.js happening to match.
    const w = world('0.2.0', '7.1.0'); // the new installer: 0.2.0, and Node.js 7.1.0 in the installed place
    store(w).close();
    placed(w, '0.1.0', '7.0.3'); // what ran before it, made for the Node.js the older installer carried
    writeFileSync(join(w.versions, 'current'), '0.1.0\n');
    behave(w, '0.2.0', { exit: 1 }); // fails its probation
    behave(w, '0.1.0', { hang: true });
    launch(w, { platform: 'win32' });
    await until('0.1.0 again', () => started(w, '0.1.0') === 1);
    expect(mark(w, 'current')).toBe('0.1.0');
    expect(JSON.parse(readFileSync(join(w.versions, 'rollback.json'), 'utf8'))).toMatchObject({ failed: '0.2.0', back: '0.1.0' });
    // Both from the one path the firewall rules name — never 0.1.0's own copy of its older Node.js.
    for (const version of ['0.2.0', '0.1.0']) {
      const ran = runs(w).split('\n').find((l) => l.startsWith(`${version} launcher=1`));
      expect(ran?.endsWith(`runtime=${w.runtime}`)).toBe(true);
      expect(ran).toContain('installed=7.1.0 '); // …and told the installed Node.js as it is on disk
    }
  }, 20_000);

  it('one launcher per data folder: a second one (the icon clicked again, no system service) leaves at once and starts nothing', async () => {
    const w = world('0.1.0');
    behave(w, '0.1.0', { hang: true });
    const first = launch(w);
    await until('the first run', () => started(w, '0.1.0') === 1);
    const second = launch(w);
    expect(await second.exited).toBe(0);
    expect(second.said()).toContain('another launcher already runs the program');
    expect(started(w, '0.1.0')).toBe(1);
    first.child.kill('SIGTERM');
    expect(await first.exited).toBe(0);
    launch(w); // the first one gone, the next one runs it
    await until('a run by the next launcher', () => started(w, '0.1.0') === 2);
  }, 20_000);

  it('a version that finds the owner’s port taken is no failed start: no going back to «previous», however often', async () => {
    const w = world('0.1.0');
    placed(w, '0.1.0');
    placed(w, '0.2.0');
    writeFileSync(join(w.versions, 'current'), '0.2.0\n');
    writeFileSync(join(w.versions, 'previous'), '0.1.0\n');
    behave(w, '0.2.0', { exit: 76 });
    behave(w, '0.1.0', { hang: true });
    launch(w, { portRetryMs: 100 });
    await until('a fourth start of 0.2.0', () => started(w, '0.2.0') >= 4);
    expect(started(w, '0.1.0')).toBe(0);
    expect(mark(w, 'current')).toBe('0.2.0');
    expect(mark(w, 'previous')).toBe('0.1.0');
    expect(existsSync(join(w.versions, 'rollback.json'))).toBe(false);
  }, 20_000);

  it('…and no switch is undone for it: the new version, still on probation, is simply tried again', async () => {
    const w = world('0.1.0');
    store(w).close();
    placed(w, '0.2.0');
    behave(w, '0.1.0', { switchTo: '0.2.0' });
    behave(w, '0.2.0', { exit: 76, then: { commit: true, hang: true } });
    launch(w, { portRetryMs: 100 });
    await until('the probation passed', () => mark(w, 'previous') === '0.1.0' && !existsSync(join(w.versions, 'pending.json')));
    expect(started(w, '0.2.0')).toBe(2);
    expect(started(w, '0.1.0')).toBe(1);
    expect(existsSync(join(w.versions, 'rollback.json'))).toBe(false);
  }, 20_000);
});
