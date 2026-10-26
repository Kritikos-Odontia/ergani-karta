// SPDX-License-Identifier: EUPL-1.2
import { isValidAfm } from '../config.js';
import { inTransaction } from '../records/store.js';
import { hashPin, oneTimePin, pinMatches, pinProblem } from './pin.js';
import { isoOf, type StampStore } from './store.js';

/**
 * THE PEOPLE WHO STAMP — added, exempted, renamed, deactivated by the owner (`admin.ts`); identified at the screen by
 * their own PIN (`checkPin`).
 *
 * ⛔ NOTHING HERE WRITES A CARD. The owner's tools change who may stamp; only the person, with their PIN, stamps
 * (`capture.ts`, docs/RULES.md rule 1).
 * ⚠ must_stamp defaults TRUE; an exemption needs a reason and is logged (docs/RULES.md rule 6). Never inferred.
 */

export interface Person {
  id: number;
  afm: string;
  surname: string;
  firstName: string;
  displayName: string;
  mustStamp: boolean;
  exemptReason: string | undefined;
  active: boolean;
  pinIsTemporary: boolean;
  lockedUntilMs: number | undefined;
}

/** Wrong PINs in a row before the name is locked, and for how long. */
export const MAX_WRONG_PINS = 5;
export const LOCK_MS = 10 * 60_000;

const PROOF: unique symbol = Symbol('a PIN was checked');

/**
 * A person whose PIN was just checked at the screen. ⛔ Only `checkPin` and `choosePin` can make one — the
 * constructor wants a symbol this module never exports — and the card writer takes nothing else. That is how «the
 * employee acts» is held by the code: no path reaches a card without the person's own PIN.
 */
export class VerifiedPerson {
  /**
   * ⚠ The brand. Without a private field TypeScript would accept ANY `{ employeeId, displayName }` where a
   * VerifiedPerson is asked for (types are structural), and the card writer would take a plain object; with it, only
   * an instance made here type-checks, and `VerifiedPerson.is` proves it again at run time.
   */
  readonly #checked = true;
  readonly employeeId: number;
  readonly displayName: string;
  constructor(proof: typeof PROOF, employeeId: number, displayName: string) {
    if (proof !== PROOF) throw new Error('only a checked PIN makes a VerifiedPerson');
    this.employeeId = employeeId;
    this.displayName = displayName;
  }

  /** Was `x` made by a checked PIN — an instance of this class, not something shaped like one? */
  static is(x: unknown): x is VerifiedPerson {
    return typeof x === 'object' && x !== null && #checked in x;
  }
}

/**
 * Names as ΕΡΓΑΝΗ holds them: upper case, no accents, single spaces. ⓘ The ministry's own examples are upper case
 * («ΚΑΠΟΙΟΣ», «ΑΛΛΟΣ»), and so is every name on the printed QR cards; a card that spells a name differently from the
 * register is a needless reason for a refusal.
 */
export function registerName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToPerson(r: Record<string, unknown>): Person {
  return {
    id: Number(r['id']),
    afm: String(r['afm']),
    surname: String(r['surname']),
    firstName: String(r['first_name']),
    displayName: String(r['display_name']),
    mustStamp: r['must_stamp'] === 1,
    exemptReason: r['exempt_reason'] === null ? undefined : String(r['exempt_reason']),
    active: r['active'] === 1,
    pinIsTemporary: r['pin_is_temporary'] === 1,
    lockedUntilMs: r['locked_until_ms'] === null ? undefined : Number(r['locked_until_ms']),
  };
}

export function allStaff(db: StampStore): Person[] {
  return db.prepare('SELECT * FROM employees ORDER BY display_name, id').all().map(rowToPerson);
}

/** The buttons on the page: active people who stamp. */
export function stampingStaff(db: StampStore): Person[] {
  return allStaff(db).filter((p) => p.active && p.mustStamp);
}

export function personById(db: StampStore, id: number): Person | undefined {
  const r = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  return r === undefined ? undefined : rowToPerson(r);
}

export function personByAfm(db: StampStore, afm: string): Person {
  const r = db.prepare('SELECT * FROM employees WHERE afm = ?').get(afm);
  if (r === undefined) throw new Error('no one with that ΑΦΜ is on this employer\'s list.');
  return rowToPerson(r);
}

function logEvent(db: StampStore, employeeId: number, kind: string, detail: string, by: string, nowMs: number): void {
  db.prepare('INSERT INTO employee_events (employee_id, at, kind, detail, by) VALUES (?, ?, ?, ?, ?)').run(
    employeeId,
    isoOf(nowMs),
    kind,
    detail,
    by,
  );
}

export interface NewPerson {
  afm: string;
  surname: string;
  firstName: string;
  /** What the page and the phone call them. Default: the first name. */
  displayName?: string | undefined;
  /** Set ONLY for someone who does not stamp (a dentist), with the reason. Default: they stamp. */
  exemptReason?: string | undefined;
}

/**
 * Add a person. Returns the one-time PIN to hand over, for someone who stamps. ⛔ The ΑΦΜ must pass the mod-11
 * check: a card names a real person by it, and a transposed digit names somebody else.
 */
export async function addPerson(
  db: StampStore,
  input: NewPerson,
  by: string,
  nowMs: number,
): Promise<{ id: number; oneTimePin: string | undefined }> {
  if (!isValidAfm(input.afm)) throw new Error('that is not a well-formed Greek ΑΦΜ (nine digits, check digit).');
  const surname = registerName(input.surname);
  const firstName = registerName(input.firstName);
  if (surname === '' || surname.length > 50) throw new Error('the surname must be 1–50 characters (Card_v1.xsd).');
  if (firstName === '' || firstName.length > 30) throw new Error('the first name must be 1–30 characters (Card_v1.xsd).');
  const displayName = (input.displayName ?? input.firstName).trim();
  if (displayName === '' || displayName.length > 40) throw new Error('the display name must be 1–40 characters.');
  const exempt = input.exemptReason?.trim();
  if (exempt === '') throw new Error('an exemption needs its reason.');

  const pin = exempt === undefined ? oneTimePin() : undefined;
  const hash = pin === undefined ? null : await hashPin(pin);
  const id = inTransaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO employees (afm, surname, first_name, display_name, must_stamp, exempt_reason, pin_hash, pin_is_temporary)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
      )
      .get(input.afm, surname, firstName, displayName, exempt === undefined ? 1 : 0, exempt ?? null, hash);
    const newId = Number(row?.['id']);
    logEvent(db, newId, 'added', '', by, nowMs);
    if (exempt !== undefined) logEvent(db, newId, 'exempted', exempt, by, nowMs);
    else logEvent(db, newId, 'pin_issued', 'one-time', by, nowMs);
    return newId;
  });
  return { id, oneTimePin: pin };
}

/** A new one-time PIN (forgotten PIN, or a lock to lift). The person chooses their own again at the screen. */
export async function issuePin(db: StampStore, afm: string, by: string, nowMs: number): Promise<string> {
  const person = personByAfm(db, afm);
  if (!person.mustStamp) throw new Error('this person is exempt and does not stamp.');
  const pin = oneTimePin();
  const hash = await hashPin(pin);
  inTransaction(db, () => {
    db.prepare(
      'UPDATE employees SET pin_hash = ?, pin_is_temporary = 1, failed_pins = 0, locked_until_ms = NULL WHERE id = ?',
    ).run(hash, person.id);
    logEvent(db, person.id, 'pin_issued', 'one-time', by, nowMs);
  });
  return pin;
}

export async function exemptPerson(db: StampStore, afm: string, reason: string, by: string, nowMs: number): Promise<void> {
  const person = personByAfm(db, afm);
  if (reason.trim() === '') throw new Error('an exemption needs its reason.');
  inTransaction(db, () => {
    db.prepare('UPDATE employees SET must_stamp = 0, exempt_reason = ? WHERE id = ?').run(reason.trim(), person.id);
    logEvent(db, person.id, 'exempted', reason.trim(), by, nowMs);
  });
}

/** Back to stamping. Returns a one-time PIN when the person had none. */
export async function includePerson(db: StampStore, afm: string, by: string, nowMs: number): Promise<string | undefined> {
  const person = personByAfm(db, afm);
  const hasPin = db.prepare('SELECT pin_hash FROM employees WHERE id = ?').get(person.id)?.['pin_hash'] !== null;
  const pin = hasPin ? undefined : oneTimePin();
  const hash = pin === undefined ? undefined : await hashPin(pin);
  inTransaction(db, () => {
    if (hash === undefined) {
      db.prepare('UPDATE employees SET must_stamp = 1, exempt_reason = NULL WHERE id = ?').run(person.id);
    } else {
      db.prepare(
        'UPDATE employees SET must_stamp = 1, exempt_reason = NULL, pin_hash = ?, pin_is_temporary = 1 WHERE id = ?',
      ).run(hash, person.id);
    }
    logEvent(db, person.id, 'included', '', by, nowMs);
    if (pin !== undefined) logEvent(db, person.id, 'pin_issued', 'one-time', by, nowMs);
  });
  return pin;
}

export function setActive(db: StampStore, afm: string, active: boolean, by: string, nowMs: number): void {
  const person = personByAfm(db, afm);
  inTransaction(db, () => {
    db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(active ? 1 : 0, person.id);
    logEvent(db, person.id, active ? 'reactivated' : 'deactivated', '', by, nowMs);
  });
}

/** Correct a name. ⓘ Cards already filed keep the name they were filed with (punches copies it). */
export function renamePerson(
  db: StampStore,
  afm: string,
  names: { surname?: string | undefined; firstName?: string | undefined; displayName?: string | undefined },
  by: string,
  nowMs: number,
): void {
  const person = personByAfm(db, afm);
  const surname = names.surname === undefined ? person.surname : registerName(names.surname);
  const firstName = names.firstName === undefined ? person.firstName : registerName(names.firstName);
  const displayName = names.displayName?.trim() ?? person.displayName;
  if (surname === '' || surname.length > 50) throw new Error('Το επώνυμο χρειάζεται 1–50 χαρακτήρες.');
  if (firstName === '' || firstName.length > 30) throw new Error('Το όνομα χρειάζεται 1–30 χαρακτήρες.');
  if (displayName === '' || displayName.length > 80) throw new Error('Το όνομα στη σελίδα χρειάζεται 1–80 χαρακτήρες.');
  inTransaction(db, () => {
    db.prepare('UPDATE employees SET surname = ?, first_name = ?, display_name = ? WHERE id = ?').run(
      surname,
      firstName,
      displayName,
      person.id,
    );
    logEvent(db, person.id, 'renamed', `${person.surname} ${person.firstName} (${person.displayName}) → ${surname} ${firstName} (${displayName})`, by, nowMs);
  });
}

export type PinCheck =
  | { kind: 'ok'; person: VerifiedPerson; mustChooseOwn: boolean }
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'locked'; untilMs: number }
  | { kind: 'not-here' };

/**
 * Check a PIN typed at the screen for the person whose name was tapped. Five wrong in a row lock the name for ten
 * minutes (logged); a right one clears the count.
 *
 * ⚠ RACE-SAFE: a try is COUNTED before the PIN is compared (one atomic `UPDATE … RETURNING`), so several guesses sent
 * at once each take their own number, and none past the fifth is even compared. Counting after the comparison would
 * let a burst of parallel guesses all read the same count while the slow hash runs, and walk past the lock.
 */
export async function checkPin(db: StampStore, employeeId: number, pin: string, nowMs: number): Promise<PinCheck> {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (row === undefined) return { kind: 'not-here' };
  const person = rowToPerson(row);
  const hash = row['pin_hash'];
  if (!person.active || !person.mustStamp || typeof hash !== 'string') return { kind: 'not-here' };
  if (person.lockedUntilMs !== undefined && nowMs < person.lockedUntilMs) {
    return { kind: 'locked', untilMs: person.lockedUntilMs };
  }
  const reserved = db.prepare('UPDATE employees SET failed_pins = failed_pins + 1 WHERE id = ? RETURNING failed_pins').get(person.id);
  const tryNumber = Number(reserved?.['failed_pins']);
  const lock = (): PinCheck => {
    const until = nowMs + LOCK_MS;
    inTransaction(db, () => {
      db.prepare('UPDATE employees SET failed_pins = 0, locked_until_ms = ? WHERE id = ?').run(until, person.id);
      logEvent(db, person.id, 'locked', `${MAX_WRONG_PINS} wrong PINs`, 'η σελίδα της υποδοχής', nowMs);
    });
    return { kind: 'locked', untilMs: until };
  };
  if (tryNumber > MAX_WRONG_PINS) return lock();
  if (await pinMatches(pin, hash)) {
    db.prepare('UPDATE employees SET failed_pins = 0, locked_until_ms = NULL WHERE id = ?').run(person.id);
    return {
      kind: 'ok',
      person: new VerifiedPerson(PROOF, person.id, person.displayName),
      mustChooseOwn: person.pinIsTemporary,
    };
  }
  if (tryNumber >= MAX_WRONG_PINS) return lock();
  return { kind: 'wrong', triesLeft: MAX_WRONG_PINS - tryNumber };
}

/**
 * The person, just verified with their one-time PIN, chooses their own. Returns the Greek reason when it is refused.
 */
export async function chooseOwnPin(
  db: StampStore,
  who: VerifiedPerson,
  newPin: string,
  nowMs: number,
): Promise<{ ok: true; person: VerifiedPerson } | { ok: false; problem: string }> {
  // ⛔ ONLY WHILE THE PIN IS STILL THE ONE-TIME ONE — checked FIRST, and again atomically below. The one-time PIN can be
  // typed twice (two tickets): once she has chosen her own, the other ticket must be worth nothing — not a way to
  // overwrite her PIN and stamp as her (docs/RULES.md rule 1), and not an oracle that tests guesses against her new PIN.
  const already = 'Ο κωδικός έχει ήδη οριστεί. Ξεκινήστε πάλι από το όνομά σας.';
  const row = db.prepare('SELECT pin_hash, pin_is_temporary FROM employees WHERE id = ?').get(who.employeeId);
  if (row?.['pin_is_temporary'] !== 1) return { ok: false, problem: already };
  const problem = pinProblem(newPin);
  if (problem !== undefined) return { ok: false, problem };
  const current = row['pin_hash'];
  if (typeof current === 'string' && (await pinMatches(newPin, current))) {
    return { ok: false, problem: 'Διαλέξτε άλλον κωδικό από αυτόν που σας δόθηκε.' };
  }
  const hash = await hashPin(newPin);
  const chosen = inTransaction(db, () => {
    const changed = db
      .prepare('UPDATE employees SET pin_hash = ?, pin_is_temporary = 0 WHERE id = ? AND pin_is_temporary = 1')
      .run(hash, who.employeeId).changes;
    if (changed !== 1) return false;
    logEvent(db, who.employeeId, 'pin_chosen', '', who.displayName, nowMs);
    return true;
  });
  if (!chosen) return { ok: false, problem: already };
  return { ok: true, person: new VerifiedPerson(PROOF, who.employeeId, who.displayName) };
}

/** Lift a lock without changing the PIN (the owner, after a word with the person). */
export function unlockPerson(db: StampStore, afm: string, by: string, nowMs: number): void {
  const person = personByAfm(db, afm);
  inTransaction(db, () => {
    db.prepare('UPDATE employees SET failed_pins = 0, locked_until_ms = NULL WHERE id = ?').run(person.id);
    logEvent(db, person.id, 'unlocked', '', by, nowMs);
  });
}
