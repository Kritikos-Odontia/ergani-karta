// SPDX-License-Identifier: EUPL-1.2
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { athensInstant } from '../src/stamp/athens.js';
import { DOWN_AFTER_MS, ReachWatch } from '../src/stamp/reach.js';
import { startErganiFake, type ErganiFake } from './fake/ergani-fake.js';

/**
 * «ΔΕΝ ΦΤΑΝΩ ΤΗΝ ΕΡΓΑΝΗ» (src/stamp/reach.ts) — against the local fake, and against a port where nothing listens.
 * ⛔ Nothing leaves 127.0.0.1.
 */
let fakes: ErganiFake[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('whether ΕΡΓΑΝΗ answers', () => {
  it('any HTTP answer, whatever its status, is «it answers»: no line', async () => {
    const fake = await startErganiFake();
    fakes.push(fake);
    let clock = athensInstant('2026-10-21', '09:00');
    const watch = new ReachWatch({ baseUrl: fake.baseUrl, now: () => clock });
    clock += DOWN_AFTER_MS * 3;
    await watch.probe();
    expect(watch.warnings(clock)).toEqual([]);
    expect(watch.silentSinceMs(clock)).toBeUndefined();
  });

  it('no answer for 10 minutes: an amber line with the time it stopped — and one answer clears it', async () => {
    let clock = athensInstant('2026-10-21', '09:00');
    const watch = new ReachWatch({ baseUrl: `http://127.0.0.1:${await closedPort()}/api`, now: () => clock });
    clock += 60_000;
    await watch.probe();
    expect(watch.warnings(clock)).toEqual([]);
    clock = athensInstant('2026-10-21', '09:10') - 1;
    expect(watch.warnings(clock)).toEqual([]);
    clock += 1;
    expect(watch.warnings(clock)).toEqual([
      {
        key: `reach-${athensInstant('2026-10-21', '09:00')}`,
        level: 'amber',
        text: 'Ο υπολογιστής δεν φτάνει την ΕΡΓΑΝΗ από τις 09:00. Οι κάρτες κρατιούνται και στέλνονται μόλις επανέλθει η σύνδεση.',
      },
    ]);
    const fake = await startErganiFake();
    fakes.push(fake);
    const back = new ReachWatch({ baseUrl: fake.baseUrl, now: () => clock });
    clock += DOWN_AFTER_MS;
    expect(back.warnings(clock)).toHaveLength(1);
    await back.probe();
    expect(back.warnings(clock)).toEqual([]);
  });
});
