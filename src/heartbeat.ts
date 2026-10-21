// SPDX-License-Identifier: EUPL-1.2
import type { Secret } from './config.js';

/**
 * THE HEARTBEAT — «I am alive and doing my job», told to a monitor the employer runs (Uptime Kuma's «Push» monitor,
 * or anything that takes `?status=up|down&msg=…` on a URL). A service that is down or stuck sends nothing, so the
 * monitor's silence IS the alarm: nothing on this side has to notice its own death.
 *
 *   · the stamping service beats every minute while its outbox completes its passes (stamp/main.ts);
 *   · the monthly archive beats after each daily run: «up» only when every month it keeps is held, «down» for a
 *     month that needs a person (records/daily.ts), and nothing when a run failed.
 *
 * ⛔ The URL carries the monitor's token: it is a `Secret`, and an error says only what kind of failure it was.
 */
export type Heartbeat = (status: 'up' | 'down', message: string) => Promise<void>;

export function heartbeatSender(url: Secret, transport: typeof fetch = globalThis.fetch): Heartbeat {
  return async (status, message) => {
    // Uptime Kuma shows its push URL with `?status=up&msg=OK&ping=` on the end; the status and message are ours to send.
    const target = new URL(url.expose());
    target.search = '';
    target.searchParams.set('status', status);
    target.searchParams.set('msg', message.slice(0, 200));
    target.searchParams.set('ping', '');
    let res: Response;
    try {
      res = await transport(target, { method: 'GET', signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      // ⛔ The cause may carry the address; only its kind is kept.
      throw new Error(`the monitor did not answer (${error instanceof Error ? error.name : 'error'})`);
    }
    await res.body?.cancel();
    if (!res.ok) throw new Error(`the monitor answered HTTP ${res.status}`);
  };
}
