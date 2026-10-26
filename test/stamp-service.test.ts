// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEmployerConfig } from '../src/config.js';
import { runStampService } from '../src/stamp/main.js';
import { initStampStore, openStampStore } from '../src/stamp/store.js';
import { startErganiFake } from './fake/ergani-fake.js';
import { AFM } from './fixtures/people.js';

/**
 * THE STAMPING SERVICE when its page cannot open at the start — the address not on the computer yet (the Wi-Fi not up
 * at sign-in, a new address from the router) or the port held by another program. The service never ends for it: it
 * says why, keeps the outbox going, and opens the page as soon as it can. (It used to end at once, and under the
 * desktop launcher three such ends read as a version that keeps stopping at start.) ΕΡΓΑΝΗ is a closed loopback port.
 */
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

describe('the stamping service’s page', () => {
  it('reads schedules only for active branches that enable them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'karta-service-schedules-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const fake = await startErganiFake({ now: Date.now, employerAfm: AFM.employer, branchLogins: {
      '0': { username: 'fixture01', password: 'Fixture.p1' },
      '1': { username: 'fixture02', password: 'Fixture.p2' },
      '2': { username: 'fixture03', password: 'Fixture.p3' },
    } });
    cleanup.push(() => fake.close());
    const env: NodeJS.ProcessEnv = {
      STAMP_INSTANCE: 'fixture', STAMP_DB: join(root, 'stamp.sqlite'), STAMP_PORT: '0',
      ERGANI_EMPLOYER_AFM: AFM.employer, ERGANI_USERTYPE: '02', ERGANI_BASE_URL: fake.baseUrl,
      ERGANI_BRANCHES: '0,1,2',
      ERGANI_BRANCH_0_USERNAME: 'fixture01', ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1', STAMP_BRANCH_0_LABEL: 'Α',
      ERGANI_BRANCH_1_USERNAME: 'fixture02', ERGANI_BRANCH_1_PASSWORD: 'Fixture.p2', STAMP_BRANCH_1_LABEL: 'Β', STAMP_BRANCH_1_SCHEDULE: 'none',
      ERGANI_BRANCH_2_USERNAME: 'fixture03', ERGANI_BRANCH_2_PASSWORD: 'Fixture.p3', STAMP_BRANCH_2_LABEL: 'Γ',
    };
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    env.STAMP_PORT = String((holder.address() as { port: number }).port);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    const instance = { name: 'fixture', realm: loadEmployerConfig(env).erganiRealm, employerAfm: AFM.employer };
    const db = initStampStore(env.STAMP_DB!, instance, ['0', '1', '2'], new Date().toISOString());
    db.prepare("INSERT INTO settings_events (at, kind, subject, detail, by) VALUES ('now', 'branch-retired', '0', '{}', 'fixture')").run();
    db.close();
    const reader = openStampStore(env.STAMP_DB!, instance);
    cleanup.push(() => reader.close());
    const service = await runStampService(env, { onSignals: false, log: () => {} });
    cleanup.push(() => service.stop());
    // Branch 2 is last, so its completed read also proves earlier retired/disabled branches were skipped.
    let complete = false;
    for (let i = 0; i < 100 && !complete; i++) {
      complete = reader.prepare("SELECT 1 FROM schedule_reads WHERE branch = '2'").get() !== undefined;
      if (!complete) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(complete).toBe(true);
    expect(fake.requests.filter((r) => r.route === 'Authentication').map((r) => JSON.parse(r.body).Username)).toEqual(['fixture03']);
    expect(reader.prepare('SELECT DISTINCT branch FROM schedule_reads').all()).toEqual([{ branch: '2' }]);
  }, 20_000);

  it('its port held by another program at the start: the service stays up, says why, and opens the page once the port is free', async () => {
    const root = mkdtempSync(join(tmpdir(), 'karta-service-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as { port: number }).port;
    const env: NodeJS.ProcessEnv = {
      STAMP_INSTANCE: 'testclinic',
      STAMP_DB: join(root, 'stamp.sqlite'),
      STAMP_PORT: String(port),
      STAMP_LISTEN_HOST: '127.0.0.1',
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: 'http://127.0.0.1:9/WebservicesAPI/api',
    };
    const instance = { name: 'testclinic', realm: loadEmployerConfig(env).erganiRealm, employerAfm: AFM.employer };
    initStampStore(env['STAMP_DB']!, instance, ['0'], new Date().toISOString()).close();

    const service = await runStampService(env, { onSignals: false, listenRetryMs: 100 });
    cleanup.push(() => service.stop());
    await new Promise((r) => setTimeout(r, 300)); // a few tries, all refused
    expect(service.pageProblem()).toBe('EADDRINUSE');

    await new Promise<void>((resolve) => holder.close(() => resolve()));
    for (let i = 0; i < 100 && service.pageProblem() !== undefined; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(service.pageProblem()).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBeLessThan(500);
  }, 20_000);
});
