// SPDX-License-Identifier: EUPL-1.2
import { DatabaseSync } from 'node:sqlite';

/**
 * ONE OUTBOX PER STORE — a lock held for the whole life of the stamping process.
 *
 * Rule 3's bound and «one arrival, one card» both assume that exactly one process sends a store's cards: the outbox
 * sends them one at a time, so the bound's look and another card's send never run at once (docs/DECISIONS.md). A
 * second `ergani stamp` on the same store — `docker compose run --rm stamp` with no command, say — would break both:
 * it would send every pending card a second time, and could send a ΛΗΞΗ while the first sends that day's ΕΝΑΡΞΗ.
 *
 * So the service takes this lock before it opens the store and refuses to start without it. The lock is SQLite's own
 * exclusive lock on a small file beside the store (`<store>.lock`, which holds nothing), and it is never let go while
 * the process lives: the system releases it only when the process ends — a clean stop, a crash or a kill. A process
 * that is paused mid-send (a paused container, a machine asleep) still holds it when it resumes, so no second process
 * can have started sending meanwhile; a lease that lapses by the clock could not promise that. It holds between
 * containers that share the store's volume on one machine.
 */
export class StoreLock {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** The lock on `storePath`, or `undefined` when another process (or another holder in this one) has it. */
  static take(storePath: string): StoreLock | undefined {
    const db = new DatabaseSync(`${storePath}.lock`);
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      // Never committed: the open transaction is the lock.
      db.exec('BEGIN EXCLUSIVE');
      const lock = new StoreLock(db);
      HELD.add(lock);
      return lock;
    } catch (error) {
      db.close();
      if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) return undefined;
      throw error;
    }
  }

  /** Give it up, on a clean stop. */
  release(): void {
    if (this.#db.isOpen) this.#db.close();
    HELD.delete(this);
  }
}

const SQLITE_BUSY = 5;
/**
 * Every lock not yet released, held here so that it lives exactly as long as it is held: a connection nothing refers
 * to may be collected and closed, which would let the lock go silently — so the lock never depends on its caller
 * happening to keep a reference.
 */
const HELD = new Set<StoreLock>();
