// SPDX-License-Identifier: EUPL-1.2
import { randomBytes } from 'node:crypto';
import type { FilingClient } from '../../src/stamp/outbox.js';
import { Outbox } from '../../src/stamp/outbox.js';
import { addPerson, issuePin, type NewPerson } from '../../src/stamp/staff.js';
import type { Instance, StampStore } from '../../src/stamp/store.js';

/** The PINs the tests choose as a person's own. */
export const TEST_PINS: readonly string[] = ['2580', '1397'];

/**
 * `addPerson`, but never with a one-time PIN a test is about to choose as the person's own. ⓘ `chooseOwnPin` rightly
 * refuses a new PIN equal to the one handed over, and the one-time PIN is random: a test that always chose «2580»
 * failed whenever the draw was «2580» too — about one run in five thousand. A drawn PIN that collides is simply drawn
 * again (`issuePin`, logged like any reissue); every other run is exactly `addPerson`.
 */
export async function addPersonForTest(
  db: StampStore,
  input: NewPerson,
  by: string,
  nowMs: number,
): Promise<{ id: number; oneTimePin: string | undefined }> {
  const added = await addPerson(db, input, by, nowMs);
  let pin = added.oneTimePin;
  while (pin !== undefined && TEST_PINS.includes(pin)) pin = await issuePin(db, input.afm, by, nowMs);
  return { id: added.id, oneTimePin: pin };
}

/** A one-branch outbox (branch «0»), as most tests need it. */
export function outboxFor(o: {
  db: StampStore;
  instance: Instance;
  client: FilingClient;
  now: () => number;
  log: (line: string) => void;
}): Outbox {
  return new Outbox({ db: o.db, clients: new Map([['0', o.client]]), employerAfm: o.instance.employerAfm, now: o.now, log: o.log });
}

/** Enrol a device at `branch` directly in the store, as the tests need one. */
export function deviceAt(db: StampStore, branch = '0', label = 'Υποδοχή'): { id: number; branch: string } {
  const hash = randomBytes(32).toString('hex');
  const row = db
    .prepare('INSERT INTO devices (branch, label, token_hash, enrolled_at) VALUES (?, ?, ?, ?) RETURNING id')
    .get(branch, label, hash, 'x');
  return { id: Number(row?.['id']), branch };
}
