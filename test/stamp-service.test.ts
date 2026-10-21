// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEmployerConfig } from '../src/config.js';
import { runStampService } from '../src/stamp/main.js';
import { initStampStore } from '../src/stamp/store.js';
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
