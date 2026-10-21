// SPDX-License-Identifier: EUPL-1.2
import { athensTime } from './athens.js';
import type { BoardWarning } from './server.js';

/**
 * «ΔΕΝ ΦΤΑΝΩ ΤΗΝ ΕΡΓΑΝΗ» — whether ΕΡΓΑΝΗ's address answers at all, looked at every `PROBE_MS` even when no card is
 * waiting, so the practice hears of a broken connection before a card does. One HEAD request to ΕΡΓΑΝΗ's base
 * address: no login, no data, no token; any HTTP answer means «it answers». After `DOWN_AFTER_MS` with none, an amber
 * line on the staff page (and the owner's home): no beep, nothing for the staff to do yet.
 * ⓘ It changes nothing the outbox does: a card is kept and sent exactly as before (rules 2 and 3); a card that cannot
 * be sent in its 15 minutes has its own red line.
 */
export const PROBE_MS = 2 * 60_000;
export const DOWN_AFTER_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

export class ReachWatch {
  readonly #url: string;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  #lastAnswerMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: { baseUrl: string; now: () => number; fetch?: typeof fetch }) {
    this.#url = o.baseUrl;
    this.#now = o.now;
    this.#fetch = o.fetch ?? globalThis.fetch;
    // Until shown otherwise: answering — a program that just started has not been without ΕΡΓΑΝΗ for 10 minutes.
    this.#lastAnswerMs = o.now();
  }

  start(): void {
    void this.probe();
    this.#timer = setInterval(() => void this.probe(), PROBE_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One look. Any HTTP answer, whatever its status, is «it answers»; a refused, failed or timed-out request is not. */
  async probe(): Promise<void> {
    try {
      const answer = await this.#fetch(this.#url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
      await answer.body?.cancel();
      this.#lastAnswerMs = this.#now();
    } catch {
      /* no answer: the time of the last one stays */
    }
  }

  /** Since when ΕΡΓΑΝΗ has not answered, once that is `DOWN_AFTER_MS` or more; otherwise `undefined`. */
  silentSinceMs(nowMs: number): number | undefined {
    return nowMs - this.#lastAnswerMs >= DOWN_AFTER_MS ? this.#lastAnswerMs : undefined;
  }

  warnings(nowMs: number): BoardWarning[] {
    const since = this.silentSinceMs(nowMs);
    if (since === undefined) return [];
    return [
      {
        key: `reach-${since}`,
        level: 'amber',
        text: `Ο υπολογιστής δεν φτάνει την ΕΡΓΑΝΗ από τις ${athensTime(since).time.slice(0, 5)}. Οι κάρτες κρατιούνται και στέλνονται μόλις επανέλθει η σύνδεση.`,
      },
    ];
  }
}
