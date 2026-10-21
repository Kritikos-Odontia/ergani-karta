// SPDX-License-Identifier: EUPL-1.2
import { randomInt, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * STAFF PINs — stored as scrypt hashes, never as PINs. One PIN per person, for every branch of the employer.
 *
 * ── WHY A PIN THE PERSON CHOOSES ─────────────────────────────────────────────────────────────────
 * The owner adds a person and is shown a ONE-TIME PIN to hand over. Before the first card, the person must choose
 * their own (the page asks). From then on nobody else knows it — which is what keeps docs/RULES.md rule 1 true at the
 * screen: the employer cannot stamp for them, because he cannot pass as them.
 *
 * ⓘ Four digits is ten thousand guesses; the page answers only enrolled devices on a private network, and five
 * wrong PINs lock the name for ten minutes (`staff.ts`). The hash's job is that a copy of the store does not hand
 * out PINs in clear; with four digits it slows a guesser, it does not stop one — the store itself must stay private.
 */

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

export const PIN_PATTERN = /^[0-9]{4}$/;

/** `scrypt$N$r$p$<salt b64>$<hash b64>` — the parameters travel with the hash, so they can be raised later. */
export async function hashPin(pin: string): Promise<string> {
  if (!PIN_PATTERN.test(pin)) throw new Error('a PIN is four digits');
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, KEY_LENGTH, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || salt === undefined || hash === undefined || !PIN_PATTERN.test(pin)) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Why a chosen PIN is refused, in Greek, or `undefined` if it is fine: four digits, not all the same, not a straight
 * run up or down — the PINs anyone would try first.
 */
export function pinProblem(pin: string): string | undefined {
  if (!PIN_PATTERN.test(pin)) return 'Ο κωδικός είναι 4 ψηφία.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Όχι τέσσερα ίδια ψηφία — διαλέξτε κάτι λιγότερο προφανές.';
  const steps = [1, 2, 3].map((i) => Number(pin[i]) - Number(pin[i - 1]));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'Όχι σειρά (1234, 4321…) — διαλέξτε κάτι λιγότερο προφανές.';
  }
  return undefined;
}

/** A one-time PIN for the owner to hand over: random, and never one `pinProblem` would refuse. */
export function oneTimePin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    if (pinProblem(pin) === undefined) return pin;
  }
}
