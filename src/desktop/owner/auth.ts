// SPDX-License-Identifier: EUPL-1.2
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * THE OWNER'S PASSWORD AND SESSIONS — the lock on the owner pages.
 *
 * The reception computer is used by the staff, and the owner pages hand out one-time PINs, revoke devices and decide
 * queued cards: «it only listens on this computer» is not a lock. So every owner page needs the owner's password,
 * set at setup (at least `MIN_PASSWORD` characters), kept only as an scrypt hash.
 * Sessions live in memory (a restart signs the owner out): a random token in an HttpOnly, SameSite=Strict cookie, each
 * with its own CSRF token for the forms; they end after `IDLE_MS` without use, or `MAX_MS` in all.
 * Wrong passwords: after `MAX_FAILURES` within `FAILURE_WINDOW_MS`, sign-in is refused for `LOCK_MS` — said on the page.
 */
export const MIN_PASSWORD = 10;
export const IDLE_MS = 30 * 60_000;
export const MAX_MS = 12 * 3_600_000;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 10 * 60_000;
export const LOCK_MS = 10 * 60_000;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Why `password` cannot be the owner's password, or `undefined`. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `τουλάχιστον ${MIN_PASSWORD} χαρακτήρες`;
  if (password.trim() !== password) return 'χωρίς κενά στην αρχή ή στο τέλος';
  return undefined;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface Session {
  passwordHash: string;
  csrf: string;
  startedMs: number;
  seenMs: number;
}

export type SignIn = { kind: 'ok'; token: string } | { kind: 'wrong' } | { kind: 'locked'; untilMs: number };

export class OwnerSessions {
  readonly #sessions = new Map<string, Session>();
  readonly #failures: number[] = [];
  #lockedUntil = 0;
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Check the password against `stored` — unless sign-in is locked, when the password is not even looked at. */
  signIn(password: string, stored: string): SignIn {
    const now = this.#now();
    if (now < this.#lockedUntil) return { kind: 'locked', untilMs: this.#lockedUntil };
    if (!passwordMatches(password, stored)) {
      this.#failures.push(now);
      while (this.#failures.length > 0 && now - this.#failures[0]! > FAILURE_WINDOW_MS) this.#failures.shift();
      if (this.#failures.length >= MAX_FAILURES) {
        this.#lockedUntil = now + LOCK_MS;
        this.#failures.length = 0;
        return { kind: 'locked', untilMs: this.#lockedUntil };
      }
      return { kind: 'wrong' };
    }
    this.#failures.length = 0;
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(token, { passwordHash: stored, csrf: randomBytes(32).toString('base64url'), startedMs: now, seenMs: now });
    return { kind: 'ok', token };
  }

  /** The session's CSRF token if `token` is a live session (and it is now used), else `undefined`. */
  touch(token: string | undefined, passwordHash?: string): string | undefined {
    if (token === undefined) return undefined;
    const session = this.#sessions.get(token);
    if (session === undefined) return undefined;
    const now = this.#now();
    if (passwordHash !== undefined && passwordHash !== session.passwordHash) {
      this.#sessions.delete(token);
      return undefined;
    }
    if (now - session.seenMs > IDLE_MS || now - session.startedMs > MAX_MS) {
      this.#sessions.delete(token);
      return undefined;
    }
    session.seenMs = now;
    return session.csrf;
  }

  signOut(token: string | undefined): void {
    if (token !== undefined) this.#sessions.delete(token);
  }
}

/** Constant-time comparison of two tokens of any length. */
export function sameToken(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}
