// SPDX-License-Identifier: EUPL-1.2
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE LAUNCHER, as its own process — the one part that never updates (src/update/launcher.ts). Each version it runs
 * is a stand-in (fixtures/fake-version.mjs) told what to do: pass its probation, switch, fail, hang. The runtime is a
 * small wrapper around the Node.js running the tests. What is held: the installer's version placed on first start;
 * a switch that passes; a switch that fails, and one that hangs, undone with the store as it was; a version that keeps
 * stopping at start falls back once; a newer installer over an older program is a switch on probation, and an
 * installer whose version once failed is not tried again by itself; stopping the launcher stops the program.
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
function world(bundled: string): World {
  const root = mkdtempSync(join(tmpdir(), 'karta-launcher-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, 'install');
  const data = join(root, 'data');
  mkdirSync(join(install, 'app'), { recursive: true });
  mkdirSync(data);
  const runtime = join(install, 'node');
  writeFileSync(runtime, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(runtime, 0o755);
  copyFileSync(FAKE, join(install, 'app', 'app.mjs'));
  writeFileSync(join(install, 'app', 'version.json'), JSON.stringify({ version: bundled, node: '24.0.0' }));
  return { data, install, runtime, versions: join(data, 'versions') };
}

/** A version already in `versions/`, as an update leaves it. */
function placed(w: World, version: string): void {
  const dir = join(w.versions, version);
  mkdirSync(dir, { recursive: true });
  copyFileSync(w.runtime, join(dir, 'node'));
  chmodSync(join(dir, 'node'), 0o700);
  copyFileSync(FAKE, join(dir, 'app.mjs'));
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version, node: '24.0.0' }));
}

const behave = (w: World, version: string, what: object) => writeFileSync(join(w.data, `behave-${version}.json`), JSON.stringify(what));
const runs = (w: World) => (existsSync(join(w.data, 'runs.log')) ? readFileSync(join(w.data, 'runs.log'), 'utf8') : '');
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

function launch(w: World, options: { probationMs?: number } = {}): { child: ChildProcess; exited: Promise<number | null> } {
  const code = `import(${JSON.stringify(LAUNCHER)}).then((m) => m.runLauncher({ install: ${JSON.stringify(w.install)}, runtime: ${JSON.stringify(w.runtime)}, env: process.env, probationMs: ${options.probationMs ?? 60_000} })).then((c) => process.exit(c))`;
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
  (child as ChildProcess & { said: () => string }).said = () => said;
  return { child, exited };
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
});
