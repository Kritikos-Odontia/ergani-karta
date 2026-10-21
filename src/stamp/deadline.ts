// SPDX-License-Identifier: EUPL-1.2
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '../config.js';
import { ErganiClient, type Transport } from '../ergani/client.js';

/**
 * ⚠⚠ THE 15-MINUTE WALL, ENFORCED AT THE WIRE (docs/RULES.md rule 4).
 *
 * The outbox stops starting attempts at the wall — but an attempt is more than one request: a sign-in, a token
 * refresh, a 429 waited out (`RATE_LIMIT_BACKOFF_MS`, about 70 s), a slow answer. Without this guard, an attempt begun
 * at minute 13 could still be sending at minute 17, quietly retrying a card «into compliance» after the wall.
 *
 * So every request of an attempt runs under that attempt's deadline: a request is NOT SENT once the deadline has
 * passed, and a request in flight is CUT at the deadline (and in any case after `REQUEST_TIMEOUT_MS`). The guard lives
 * in the transport — the one seam every request of the client passes through — so it holds whatever path the client
 * takes inside. Outside `withDeadline`, requests get only the per-request timeout.
 */

/** Longest any single request may take. A filing answers in well under a second when ΕΡΓΑΝΗ is healthy. */
export const REQUEST_TIMEOUT_MS = 20_000;

const deadlines = new AsyncLocalStorage<number>();

/** The wall was reached: this request was not sent. */
export class DeadlineReachedError extends Error {
  constructor() {
    super('not sent: the 15-minute wall was reached (the last moment the outbox may send a card)');
    this.name = 'DeadlineReachedError';
  }
}

/** Run `work` with every request it makes bounded by `deadlineMs` (epoch ms, on `now`'s clock). */
export function withDeadline<T>(deadlineMs: number, work: () => Promise<T>): Promise<T> {
  return deadlines.run(deadlineMs, work);
}

/**
 * Wrap a transport so it honours the deadline of the attempt it runs in. `now` is the service's clock (injected, so
 * tests can stand at minute 14 without waiting for it).
 */
export function deadlineTransport(base: Transport, now: () => number, requestTimeoutMs = REQUEST_TIMEOUT_MS): Transport {
  return ((input: Parameters<Transport>[0], init?: Parameters<Transport>[1]) => {
    const deadline = deadlines.getStore();
    const left = deadline === undefined ? requestTimeoutMs : Math.min(requestTimeoutMs, deadline - now());
    if (left <= 0) return Promise.reject(new DeadlineReachedError());
    const signal = AbortSignal.timeout(left);
    return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  }) as Transport;
}

/**
 * ⛔ THE CLIENT THE STAMPING SERVICE FILES WITH — and the only way `main.ts` makes one (a test holds it to that, by
 * reading the file): every request it sends honours the deadline of the attempt it runs in. A client built any other
 * way would let a sign-in, a refresh or a 429 wait carry a card past the wall, with nothing in the suite going red.
 */
export function filingClient(config: Config, now: () => number, base: Transport = globalThis.fetch): ErganiClient {
  return new ErganiClient(config, { transport: deadlineTransport(base, now), now });
}
