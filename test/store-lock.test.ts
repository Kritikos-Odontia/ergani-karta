// SPDX-License-Identifier: EUPL-1.2
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStampService } from '../src/stamp/main.js';
import { StoreLock } from '../src/stamp/store-lock.js';
import { AFM } from './fixtures/people.js';

/**
 * ONE OUTBOX PER STORE (src/stamp/store-lock.ts): while one process holds a store's lock, no other gets it — not when
 * the holder is paused, not however long it waits — and the system hands it on only when the holder ends.
 * Real separate processes, as two stamping services would be. Nothing reaches a network.
 */

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-lock-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'stamp.sqlite');
}

/**
 * Another process holding the lock on `path`, once it says so. `dropped`: it keeps no reference to the lock it took,
 * and has the garbage collector run before it says so — the lock must hold all the same.
 */
async function holderProcess(path: string, dropped = false): Promise<ChildProcess> {
  const source = new URL('../src/stamp/store-lock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e',
      `const { StoreLock } = await import(${JSON.stringify(source)});
       const took = ${dropped ? `StoreLock.take(${JSON.stringify(path)}) !== undefined` : `globalThis.lock = StoreLock.take(${JSON.stringify(path)})`};
       for (let i = 0; i < 5; i += 1) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
       console.log(took ? 'held' : 'refused');
       setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cleanup.push(() => child.kill('SIGKILL'));
  const said = await new Promise<string>((resolve) => child.stdout!.once('data', (d) => resolve(String(d).trim())));
  expect(said).toBe('held');
  return child;
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => child.once('exit', () => resolve()));

describe('one outbox per store', () => {
  it('refuses a second holder in the same process until the first lets go', () => {
    const path = storePath();
    const first = StoreLock.take(path);
    expect(first).toBeDefined();
    expect(StoreLock.take(path)).toBeUndefined();
    first!.release();
    const second = StoreLock.take(path);
    expect(second).toBeDefined();
    second!.release();
  });

  it.skipIf(process.platform === 'win32')(
    '⛔ another process holding it — even paused — keeps it; only when that process ends is it free',
    async () => {
      const path = storePath();
      const holder = await holderProcess(path);
      expect(StoreLock.take(path)).toBeUndefined();
      // Paused, as a suspended container or a sleeping machine would be: still held — no clock runs it out.
      holder.kill('SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(StoreLock.take(path)).toBeUndefined();
      // It dies without a word (a crash): the system releases the lock.
      const gone = exited(holder);
      holder.kill('SIGKILL');
      await gone;
      const mine = StoreLock.take(path);
      expect(mine).toBeDefined();
      mine!.release();
    },
    20_000,
  );

  it('⛔ the stamping service refuses to start while another holds its store\'s lock — before it opens the store', async () => {
    const path = storePath();
    const held = StoreLock.take(path);
    cleanup.push(() => held?.release());
    const env: NodeJS.ProcessEnv = {
      STAMP_INSTANCE: 'testclinic',
      STAMP_DB: path,
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: 'http://127.0.0.1:9/WebservicesAPI/api',
    };
    // No store exists at STAMP_DB: a service that got past the lock would fail on that instead.
    await expect(runStampService(env)).rejects.toThrow(/another stamping service is already running on this store/);
  });

  it('⛔ holds while its process lives even when nothing in that process keeps a reference to it', async () => {
    const path = storePath();
    await holderProcess(path, true);
    expect(StoreLock.take(path)).toBeUndefined();
  });

  it('locks per store: another store\'s lock is its own', () => {
    const one = StoreLock.take(storePath());
    const other = StoreLock.take(storePath());
    expect(one).toBeDefined();
    expect(other).toBeDefined();
    one!.release();
    other!.release();
  });
});
