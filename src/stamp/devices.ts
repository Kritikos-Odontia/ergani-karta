// SPDX-License-Identifier: EUPL-1.2
import { createHash, randomBytes } from 'node:crypto';
import { inTransaction } from '../records/store.js';
import { isoOf, storeBranches, type StampStore } from './store.js';

/**
 * THE COMPUTERS ALLOWED TO SHOW A BRANCH'S PAGE.
 *
 * The network decides who can REACH the page (the page is published on a private address only, docs/INSTALL.md).
 * This decides who can SEE it: a device is enrolled once, at one branch, by opening a one-time link the owner makes on
 * the server, and from then on carries a random token in a cookie. A device that is not enrolled is shown nothing —
 * no names, no board — and nobody can stamp from anywhere but an enrolled reception computer. Every card records the
 * device it was stamped on, and is that device's branch's card.
 *
 * ⓘ Only the SHA-256 of a token is kept: a copy of the store does not let anyone pose as the reception computer.
 */

/** How long a one-time enrolment link works. */
export const ENROLLMENT_TTL_MS = 30 * 60_000;

export interface Device {
  id: number;
  /** The branch whose page this device shows, and whose cards it makes. */
  branch: string;
  label: string;
  enrolledAt: string;
  revokedAt: string | undefined;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A one-time enrolment token for a device called `label`, at `branch`. The owner opens `/enroll/<token>` on that computer. */
export function createEnrollment(db: StampStore, branch: string, label: string, nowMs: number): string {
  const clean = label.trim();
  if (clean === '' || clean.length > 60) throw new Error('a device label is 1–60 characters, e.g. «Υποδοχή».');
  if (!storeBranches(db).includes(branch)) throw new Error(`branch ${branch} is not in this store.`);
  const token = newToken();
  db.prepare('INSERT INTO enrollments (branch, label, token_hash, created_at, expires_ms) VALUES (?, ?, ?, ?, ?)').run(
    branch,
    clean,
    tokenHash(token),
    isoOf(nowMs),
    nowMs + ENROLLMENT_TTL_MS,
  );
  return token;
}

/**
 * Trade a one-time enrolment token for a device token (the cookie). `undefined` when the link is unknown, used or
 * expired — said the same way in all three cases, so a guesser learns nothing.
 */
export function redeemEnrollment(db: StampStore, token: string, nowMs: number): string | undefined {
  return inTransaction(db, () => {
    const row = db
      .prepare('SELECT id, branch, label FROM enrollments WHERE token_hash = ? AND used_at IS NULL AND expires_ms > ?')
      .get(tokenHash(token), nowMs);
    if (row === undefined) return undefined;
    const deviceToken = newToken();
    const device = db
      .prepare('INSERT INTO devices (branch, label, token_hash, enrolled_at) VALUES (?, ?, ?, ?) RETURNING id')
      .get(String(row['branch']), String(row['label']), tokenHash(deviceToken), isoOf(nowMs));
    db.prepare('UPDATE enrollments SET used_at = ?, device_id = ? WHERE id = ?').run(
      isoOf(nowMs),
      Number(device?.['id']),
      Number(row['id']),
    );
    return deviceToken;
  });
}

/** The enrolled, unrevoked device this cookie token belongs to. */
export function deviceByToken(db: StampStore, token: string | undefined): Device | undefined {
  if (token === undefined || token === '') return undefined;
  const row = db
    .prepare('SELECT id, branch, label, enrolled_at, revoked_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash(token));
  return row === undefined ? undefined : toDevice(row);
}

export function allDevices(db: StampStore): Device[] {
  return db.prepare('SELECT id, branch, label, enrolled_at, revoked_at FROM devices ORDER BY id').all().map(toDevice);
}

export function revokeDevice(db: StampStore, id: number, nowMs: number): void {
  const result = db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(isoOf(nowMs), id);
  if (result.changes !== 1) throw new Error('no enrolled device with that number.');
}

function toDevice(r: Record<string, unknown>): Device {
  return {
    id: Number(r['id']),
    branch: String(r['branch']),
    label: String(r['label']),
    enrolledAt: String(r['enrolled_at']),
    revokedAt: r['revoked_at'] === null ? undefined : String(r['revoked_at']),
  };
}
