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

/** `key` is the alarm's own key (alarms.ts): its first part says what kind of alarm it is. */
export type PushSender = (push: Push, key?: string) => Promise<void>;

// ── THE EASY MODE: nameless pushes through the free public ntfy.sh (his «Yes», 21/10) ─────────────────────────────
// A practice without its own ntfy server can still be told «look at the page». ⛔ This sender CANNOT carry a name: it
// never reads the push's title or message — it sends one of the fixed sentences below, chosen by the alarm's kind, under
// a fixed title (not even the practice's name). So nothing personal reaches ntfy.sh, where a topic is readable by anyone
// who knows it; the topic is long and random, and the owner can make a new one. ntfy.sh is used by THIS sender only:
// `ntfySender` (pushes with names) refuses it, in its settings and again when it sends.
export const EASY_SERVER = 'https://ntfy.sh';
export const EASY_TITLE = 'Κάρτα Εργασίας';
const LOOK = ' — δείτε τη σελίδα στο ιατρείο.';
export const NAMELESS: Readonly<Record<string, string>> = {
  'no-start': `Κάποιος δεν χτύπησε ΕΝΑΡΞΗ${LOOK}`,
  'no-end': `Κάποιος δεν χτύπησε ΛΗΞΗ${LOOK}`,
  'end-without-start': `Μια ΛΗΞΗ χωρίς ΕΝΑΡΞΗ σήμερα${LOOK}`,
  overdue: 'Μια κάρτα δεν έχει φτάσει ακόμη στην ΕΡΓΑΝΗ· ξαναδοκιμάζεται.',
  queue: `Μια κάρτα δεν στάλθηκε στην ΕΡΓΑΝΗ${LOOK}`,
  refused: `Η ΕΡΓΑΝΗ δεν δέχτηκε μια κάρτα${LOOK}`,
  resolved: 'Μια κάρτα που είχε καθυστερήσει τακτοποιήθηκε ✓',
  'proof-missing': `Λείπουν αποδεικτικά PDF καρτών${LOOK}`,
  'schedule-unknown': `Δεν διαβάστηκε σήμερα το ωράριο από την ΕΡΓΑΝΗ${LOOK}`,
  'unknown-person': `Στο ωράριο της ΕΡΓΑΝΗΣ υπάρχει άτομο που δεν είναι στη σελίδα${LOOK}`,
  test: 'ΔΟΚΙΜΗ — οι ειδοποιήσεις της Κάρτας Εργασίας φτάνουν σε αυτό το κινητό.',
  other: `Κάτι θέλει την προσοχή σας${LOOK}`,
};
export const EASY_TOPIC = /^karta-[A-Za-z0-9_-]{24,58}$/;

export function namelessText(key: string | undefined): string {
  const kind = (key ?? '').split(':')[0] ?? '';
  return Object.hasOwn(NAMELESS, kind) ? NAMELESS[kind]! : NAMELESS['other']!;
}

/** A new random topic: `karta-` and 24 random URL-safe characters (144 bits). */
export function newEasyTopic(): string {
  const { randomBytes } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  return `karta-${randomBytes(18).toString('base64url')}`;
}

export function namelessSender(topic: string, transport: typeof fetch = globalThis.fetch): PushSender {
  if (!EASY_TOPIC.test(topic)) throw new Error('the easy-mode topic is not one this program made.');
  return async (push, key) => {
    let res: Response;
    try {
      res = await transport(`${EASY_SERVER}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, title: EASY_TITLE, message: namelessText(key), priority: push.priority }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`ntfy.sh did not answer (${error instanceof Error ? error.name : 'error'})`);
    }
    await res.body?.cancel();
    if (!res.ok) throw new Error(`ntfy.sh answered HTTP ${res.status}`);
  };
}

/** ntfy.sh as DNS reads it (a trailing dot is the same server). */
export function isPublicNtfy(hostname: string): boolean {
  return /(^|\.)ntfy\.sh$/i.test(hostname.replace(/\.+$/, ''));
}

/** Remove anything that looks like an ΑΦΜ (nine digits) — a ministry sentence may quote one. */
export function withoutAfm(text: string): string {
  return text.replace(/(?<!\d)\d{9}(?!\d)/g, '…');
}

export function ntfySender(url: Secret, token: Secret, transport: typeof fetch = globalThis.fetch): PushSender {
  return async (push) => {
    const target = new URL(url.expose());
    // ⛔ A push with names never goes to the public ntfy.sh — refused in the settings (stamp/config.ts) and here again.
    if (isPublicNtfy(target.hostname)) throw new Error('a push that names a person is never sent to ntfy.sh.');
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
