// SPDX-License-Identifier: EUPL-1.2
import { inspect } from 'node:util';
import { z } from 'zod';
import { BranchAa } from './ergani/types.js';

/**
 * Boot-time configuration, and the primitive that keeps the ΕΡΓΑΝΗ password out of logs.
 *
 * ── WHY A `Secret` WRAPPER AND NOT A `string` ────────────────────────────────────────────────────
 * docs/RULES.md rule 7 says the credential is never logged, never echoed, never in an error message.
 * A rule like that, written only in prose, is one `console.log(config)` away from being false — and
 * the value it protects is a **live government credential** that (with an unscoped user) can file
 * hirings and dismissals, not just card events.
 *
 * `Secret` makes the safe thing the default at the three places a value actually escapes:
 * `JSON.stringify` (→ `toJSON`), string interpolation (→ `toString`), and `console.log` of an object
 * (→ node's `util.inspect.custom`). All three return `'[redacted]'`. Getting the real value requires
 * writing `.expose()`, which is greppable in review — the point is not that it is impossible to leak,
 * but that leaking has to be *deliberate and visible* rather than accidental.
 *
 * ⚠ It is not a security boundary. A heap dump still holds the string. It defends against the
 * failure mode that actually happens: a debug log, a thrown error carrying config, a crash reporter.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to read the real value. Greppable on purpose — see the docblock. */
  expose(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return '[redacted]';
  }
}

/**
 * Greek ΑΦΜ check digit (mod-11 over the first eight digits, weights 2^8…2^1).
 *
 * ⚠ WHY VALIDATE AT ALL, rather than let ΕΡΓΑΝΗ reject it: `f_afm_ergodoti` is checked by ΕΡΓΑΝΗ
 * against the authenticated employer, and an employee's `f_afm` identifies **which real person** a
 * declaration is about. A transposed digit does not fail loudly — it either bounces with a free-text
 * Greek sentence (no code, see docs/RULES.md rule 8) or, worse, names somebody else. Catching it at boot
 * and at entry is far cheaper than catching it in a labour inspection.
 *
 * ⓘ This proves the number is *well-formed*, never that it belongs to the person named beside it.
 */
export function isValidAfm(afm: string): boolean {
  if (!/^\d{9}$/.test(afm)) return false;
  // A run of nine identical digits passes the checksum arithmetic (000000000 sums to 0) but is never
  // a real ΑΦΜ; reject explicitly rather than relying on the mod-11 to catch it, because it does not.
  if (/^(\d)\1{8}$/.test(afm)) return false;

  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    // `noUncheckedIndexedAccess`: the regex above guarantees nine chars, but the compiler cannot see it.
    const digit = Number(afm[i]);
    sum += digit * 2 ** (8 - i);
  }
  return sum % 11 % 10 === Number(afm[8]);
}

const afm = z.string().refine(isValidAfm, { message: 'not a well-formed Greek ΑΦΜ' });

/**
 * ΕΡΓΑΝΗ `Usertype` — interoperability guide §2.1.1: `01` Εξωτερικός · `02` Σύνδεση με κωδικούς
 * «ΕΡΓΑΝΗ» · `03` Σύνδεση με κωδικούς για Οικοδομοτεχνικά Έργα από ΕΦΚΑ (construction projects).
 * ⚠ All three are EMPLOYER identities. There is no vendor, partner or delegate type — which is why
 * this is software an employer runs for itself, and never a service run on someone else's behalf.
 *
 * ⚠⚠ TWO FACTS, BOTH TRUE, NOT IN TENSION — do not "fix" one using the other:
 *   · MEASURED (2026-09-24, on a real employer account): the employer's **ΑΜΕ master** e-ΕΦΚΑ credential
 *     authenticates as `01` (token lifetime 10800 s). ⇒ The master is `01`. This software never holds it.
 *   · MEASURED (2026-09-28): a restricted **Χρήστης Παραρτήματος** signs in as `02` and reads
 *     `EX_BASE_07/08`. ⚠ Signed in as `01` it fails authentication, and that failure reads as "a restricted
 *     user cannot use the API" — the opposite of the truth.
 */
export const Usertype = z.enum(['01', '02', '03']);

/**
 * ONE BRANCH'S LOGIN. ⚠ THE LENGTH BOUNDS ARE THE MINISTRY'S, NOT OURS — Οδηγός Εφαρμογής p.356: an
 * ΕΡΓΑΝΗ sub-user name is 8–20 Latin characters and the password is 8–12 characters. We assert them at
 * boot because a truncated or shell-mangled secret otherwise fails as an opaque HTTP 400 fifteen
 * minutes into a compliance window, at the worst possible moment to be debugging a `.env` file.
 *
 * ⚠⚠ A 12-character ceiling on a static, non-expiring, non-rotatable government password is weak by
 * construction. That is the ministry's design, not a setting we can improve — it is why docs/RULES.md
 * rule 7 asks for a *restricted* Παράρτημα user, so that the weak secret opens as little as possible.
 */
const LoginSchema = z.object({
  erganiUsername: z.string().min(8).max(20),
  erganiPassword: z.string().min(8).max(12).transform((v) => new Secret(v)),
});

/**
 * A branch code (`f_aa`) as this software writes it: the branch's number in plain decimal — `0`, `1`, `12` —
 * a STRING, as `Card_v1.xsd` types it (`BranchAa`). ⓘ Canonical on purpose: `01` and `1` are the same branch to
 * ΕΡΓΑΝΗ's read services (`PararthmaAa` is an integer), and two spellings of one branch would split one branch's
 * cards, devices and records in two.
 */
export const BRANCH_CODE = /^(0|[1-9][0-9]{0,4})$/;

/**
 * WHERE THE CLIENT POINTS. ΕΡΓΑΝΗ ΙΙ has two documented API bases (interoperability guide
 * «Σύστημα Εκτέλεσης Υπηρεσιών Διαλειτουργικότητας», 18.02.2026, §1.1 and §2):
 *
 *   · `trial` — «Το σύνολο των υπηρεσιών διαλειτουργικότητας διατίθεται στο δοκιμαστικό περιβάλλον»,
 *     and what is filed there «φέρει τη σήμανση "ΑΚΥΡΟ" και δεν αποτελούν εφαρμογή οιασδήποτε
 *     νομοθεσίας». ⚠ It still needs an e-ΕΦΚΑ login, and it is still a government system.
 *   · `production` — the real register. A filing here is a legally-binding declaration about a named
 *     real person's working time, with no cancel path (docs/RULES.md rules 3 and 9).
 *
 * ⓘ The address every public SDK and the old guide give, `trialeservices.yeka.gr`, is the dead
 * ΕΡΓΑΝΗ I trial (404 on every API path). Its ΕΡΓΑΝΗ ΙΙ successor is `trialv2eservices.yeka.gr`.
 */
export const ERGANI_BASE_URLS = {
  trial: 'https://trialv2eservices.yeka.gr/WebservicesAPI/api',
  production: 'https://eservices.yeka.gr/WebservicesAPI/api',
} as const;

export type ErganiRealm = keyof typeof ERGANI_BASE_URLS | 'local';

/** The one value `ERGANI_CONFIRM_PRODUCTION` accepts. */
export const PRODUCTION_OPT_IN = 'yes';

/**
 * Resolve the realm from `ERGANI_ENV`, `ERGANI_CONFIRM_PRODUCTION` and `ERGANI_BASE_URL`.
 *
 * ── WHY A REALM AND NOT A URL ───────────────────────────────────────────────────────────────────
 * A free-text base URL is one typo, or one pasted line, away from pointing a test run at the real
 * register. So the two ΕΡΓΑΝΗ bases are reachable ONLY by name, and the default is `trial`:
 *   · `production` needs a SECOND, separate variable, `ERGANI_CONFIRM_PRODUCTION=yes`. Changing one
 *     word is not enough to reach the real register; the operator has to say so twice.
 *   · a confirmation left behind with any other realm is refused, so the opt-in cannot sit in an
 *     environment unnoticed, waiting for somebody to flip `ERGANI_ENV` later.
 *   · `ERGANI_BASE_URL` is the local-fake escape hatch and nothing else: it accepts only loopback
 *     hosts and RFC 2606 `.invalid` names, which can never be a government system, and it cannot be
 *     combined with `ERGANI_ENV`.
 *
 * ⓘ Errors name the variable, never its value — the same habit that keeps the password out of them.
 */
function resolveRealm(env: NodeJS.ProcessEnv): { erganiRealm: ErganiRealm; erganiBaseUrl: string } {
  const realm = env.ERGANI_ENV;
  const optIn = env.ERGANI_CONFIRM_PRODUCTION;
  const override = env.ERGANI_BASE_URL;

  if (override !== undefined) {
    if (realm !== undefined || optIn !== undefined) {
      throw new Error(
        'ERGANI_BASE_URL (a local fake) cannot be combined with ERGANI_ENV or ERGANI_CONFIRM_PRODUCTION — set one or the other.',
      );
    }
    if (!isLocalFake(override)) {
      throw new Error(
        'ERGANI_BASE_URL may only point at a local fake (localhost, 127.0.0.1, ::1 or a .invalid host). To reach ΕΡΓΑΝΗ, use ERGANI_ENV.',
      );
    }
    return { erganiRealm: 'local', erganiBaseUrl: override };
  }

  if (realm === 'production') {
    if (optIn !== PRODUCTION_OPT_IN) {
      throw new Error(
        `ERGANI_ENV=production reaches the REAL register. Set ERGANI_CONFIRM_PRODUCTION=${PRODUCTION_OPT_IN} as well to mean it.`,
      );
    }
    return { erganiRealm: 'production', erganiBaseUrl: ERGANI_BASE_URLS.production };
  }

  if (realm !== undefined && realm !== 'trial') {
    throw new Error('ERGANI_ENV must be exactly `trial` or `production`.');
  }
  if (optIn !== undefined) {
    throw new Error('ERGANI_CONFIRM_PRODUCTION is set but ERGANI_ENV is not `production` — remove it.');
  }
  return { erganiRealm: 'trial', erganiBaseUrl: ERGANI_BASE_URLS.trial };
}

function isLocalFake(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.invalid')
  );
}

/**
 * ONE BRANCH'S VIEW of the employer: what one ΕΡΓΑΝΗ client needs to speak for that branch — the employer, the
 * branch (`f_aa`), the branch's own restricted login, and the realm.
 */
export interface Config {
  employerAfm: string;
  /** `f_aa` — a STRING of 1–5 digits, per `Card_v1.xsd` (see `BranchAa`), in plain decimal (`BRANCH_CODE`). */
  branchCode: string;
  erganiUsername: string;
  erganiPassword: Secret;
  erganiUsertype: z.infer<typeof Usertype>;
  erganiRealm: ErganiRealm;
  erganiBaseUrl: string;
}

/**
 * THE EMPLOYER — one per installation, with every branch it has.
 *
 * ── ⭐ ONE LOGIN PER BRANCH ────────────────────────────────────────────────────────────────────────
 * A Χρήστης Παραρτήματος acts for its own branch: the ministry's CardScanner guide says it makes «όλες τις
 * ενέργειες/δηλώσεις που αφορούν το συγκεκριμένο παράρτημα», and no read can prove filing rights for another. So each
 * branch carries its own restricted login, and a card is always filed with the login of the branch it was stamped at.
 * ⓘ One POST could batch several branches of one employer (the ministry's own example does); this software never
 * does — each card is its own POST, with its own branch's login.
 */
export interface EmployerConfig {
  employerAfm: string;
  erganiRealm: ErganiRealm;
  erganiBaseUrl: string;
  /** One per branch, in the order `ERGANI_BRANCHES` lists them. Never empty. */
  branches: Config[];
}

/**
 * Parse and validate the employer's configuration. Throws on anything malformed — a boot failure is the
 * correct outcome, and vastly preferable to discovering a bad credential mid-shift.
 *
 *   ERGANI_EMPLOYER_AFM=…              the employer's ΑΦΜ (checksum-validated)
 *   ERGANI_USERTYPE=02                 the restricted users' Usertype (02 — see `Usertype`)
 *   ERGANI_BRANCHES=0,1                the branch codes, comma-separated (default `0`)
 *   ERGANI_BRANCH_<code>_USERNAME=…    that branch's restricted login
 *   ERGANI_BRANCH_<code>_PASSWORD=…
 *
 * ⚠ The thrown message must never carry the password. zod reports the failing *path*, not the
 * value, for every rule above — verified by a test, because "zod doesn't do that" is exactly the
 * kind of assumption that stops being true on a minor version bump.
 */
export function loadEmployerConfig(env: NodeJS.ProcessEnv = process.env): EmployerConfig {
  const employerAfm = afm.parse(env.ERGANI_EMPLOYER_AFM);
  const erganiUsertype = Usertype.parse(env.ERGANI_USERTYPE);
  const codes = branchCodesOf(env.ERGANI_BRANCHES ?? '0');
  const realm = resolveRealm(env);
  const branches = codes.map((code): Config => {
    const login = LoginSchema.safeParse({
      erganiUsername: env[`ERGANI_BRANCH_${code}_USERNAME`],
      erganiPassword: env[`ERGANI_BRANCH_${code}_PASSWORD`],
    });
    if (!login.success) {
      // ⚠ Built by hand rather than rethrowing zod's error: it names the variable and the rule, never the value.
      const which = login.error.issues.map((issue) => issue.path.join('.')).join(', ');
      throw new Error(
        `branch ${code}: ERGANI_BRANCH_${code}_USERNAME (8–20 characters) and ERGANI_BRANCH_${code}_PASSWORD ` +
          `(8–12 characters) must both be set — the restricted ΕΡΓΑΝΗ login of that branch (problem: ${which}).`,
      );
    }
    return { employerAfm, branchCode: code, ...login.data, erganiUsertype, ...realm };
  });
  return { employerAfm, ...realm, branches };
}

/**
 * ONE branch's view, for the tools that speak for one branch at a time (`check`, the read services): the branch
 * asked for, or — when none is asked for — the only one. An employer with several branches must say which.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, branch?: string): Config {
  return branchOf(loadEmployerConfig(env), branch);
}

export function branchOf(employer: EmployerConfig, branch: string | undefined): Config {
  if (branch === undefined) {
    const [only, ...more] = employer.branches;
    if (only === undefined || more.length > 0) {
      throw new Error(`this employer has ${employer.branches.length} branches — say which one with --branch.`);
    }
    return only;
  }
  const found = employer.branches.find((b) => b.branchCode === branch);
  if (found === undefined) throw new Error(`branch ${branch} is not in ERGANI_BRANCHES.`);
  return found;
}

/** `ERGANI_BRANCHES` as a list: canonical codes, no repeats, at least one. */
export function branchCodesOf(text: string): string[] {
  const codes = text.split(',').map((c) => c.trim());
  for (const code of codes) {
    if (!BRANCH_CODE.test(code) || !BranchAa.safeParse(code).success) {
      throw new Error(
        'ERGANI_BRANCHES must list branch numbers as ΕΡΓΑΝΗ has them, comma-separated, in plain digits (0, 1, 12 — never 01).',
      );
    }
  }
  if (new Set(codes).size !== codes.length) throw new Error('ERGANI_BRANCHES lists a branch twice.');
  return codes;
}
