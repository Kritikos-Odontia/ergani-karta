// SPDX-License-Identifier: EUPL-1.2
import type { Secret } from '../config.js';

/**
 * THE OWNER'S PHONE — a push through ntfy, to a topic that needs a login.
 *
 * ── WHY A SELF-HOSTED SERVER WITH LOGINS, AND NOT A PUBLIC ntfy.sh TOPIC ──────────────────────────
 * A push NAMES the person (the owner needs to know who is having a problem — docs/DECISIONS.md). On ntfy.sh's free
 * tier a topic has no access control: its name is the whole credential, and anyone who learns it reads every message.
 * So these pushes go to the employer's own ntfy server, where every topic is deny-all except for the owner's read-only
 * phone login and this service's write-only token (docs/NOTIFICATIONS.md). iPhone delivery may use ntfy.sh only as a
 * wake-up carrying a message id; the text stays on the employer's server.
 * ⛔ Never an ΑΦΜ in a push (`withoutAfm`). ⛔ The URL and the token are never logged, echoed or put in an error.
 *
 * Published as JSON to the server's root (ntfy's «publish as JSON»), so a Greek title travels in the body, never in an
 * HTTP header (headers are not UTF-8).
 */

export interface Push {
  title: string;
  message: string;
  /** ntfy priority: 3 default, 4 high, 5 urgent. */
  priority: 3 | 4 | 5;
}

export type PushSender = (push: Push) => Promise<void>;

/** Remove anything that looks like an ΑΦΜ (nine digits) — a ministry sentence may quote one. */
export function withoutAfm(text: string): string {
  return text.replace(/(?<!\d)\d{9}(?!\d)/g, '…');
}

export function ntfySender(url: Secret, token: Secret, transport: typeof fetch = globalThis.fetch): PushSender {
  return async (push) => {
    const target = new URL(url.expose());
    const topic = target.pathname.replace(/^\//, '');
    let res: Response;
    try {
      res = await transport(`${target.origin}/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.expose()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: withoutAfm(push.title),
          message: withoutAfm(push.message),
          priority: push.priority,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // ⛔ The cause may carry the address; only its kind is kept.
      throw new Error(`the push server did not answer (${error instanceof Error ? error.name : 'error'})`);
    }
    await res.body?.cancel();
    if (!res.ok) throw new Error(`the push server answered HTTP ${res.status}`);
  };
}
