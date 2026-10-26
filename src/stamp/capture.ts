// SPDX-License-Identifier: EUPL-1.2
import { ENARXI, LIXI, type CardEventType } from '../ergani/types.js';
import { addDays, athensInstant, athensTime, cardDateTime } from './athens.js';
import { reminderDay } from './calendar.js';
import type { Device } from './devices.js';
import { VerifiedPerson } from './staff.js';
import { isoOf, type StampStore } from './store.js';

/**
 * ⛔⛔ THE ONE PLACE A CARD IS WRITTEN.
 *
 * A card is a person's own ΕΝΑΡΞΗ or ΛΗΞΗ, made at a branch's reception page with their own PIN (`VerifiedPerson` can only
 * come from a checked PIN, staff.ts). There is no other writer and there must never be one: «Η έναρξη ή/και η λήξη
 * της ημερήσιας χρονοπαρουσίας μονομερώς από τον εργοδότη» is prohibited (ερμηνευτική εγκύκλιος; docs/RULES.md rule 1).
 * A test asserts this file is the only one in `src/` that inserts into `punches`.
 *
 * ⛔⛔ DURABLE BEFORE DISPATCH (docs/RULES.md rule 2): the row is committed here, in the request that captures it, and
 * only then is the outbox woken. Nothing on the network can lose a card.
 *
 * The instant is the server's clock at «Επιβεβαίωση», never the browser's. The branch is the enrolled device's.
 */

/**
 * A ΛΗΞΗ belongs to the working day of the person's open ΕΝΑΡΞΗ — so a shift that ends after midnight is not filed
 * against the wrong day (f_reference_date, types.ts). ⭐ Her open ΕΝΑΡΞΗ AT ANY BRANCH: the store holds every branch of
 * the employer, so an ΕΝΑΡΞΗ at one and the ΛΗΞΗ at another keep one working day. An ΕΝΑΡΞΗ is open if it was made TODAY (Athens), or yesterday
 * when it is now before this hour, or her recorded overnight calendar interval at the arrival's branch still covers
 * the departure. Only the calendar's current hours extend this boundary, not the month-late imported schedule.
 * ⚠ Never «within so many hours»: after a split shift whose 21:00 ΛΗΞΗ was forgotten,
 * the 17:00 ΕΝΑΡΞΗ is 16 hours old at 09:00 the next morning, and a window long enough for a night shift would offer
 * her ΛΗΞΗ and file it on yesterday — a false 16-hour shift on the register, which cannot be withdrawn.
 */
export const AFTER_MIDNIGHT_UNTIL = '06:00';

export interface Punch {
  id: number;
  employeeId: number;
  afm: string;
  surname: string;
  firstName: string;
  /** The branch it was stamped at (`f_aa`) — the device's. */
  branch: string;
  fType: CardEventType;
  referenceDate: string;
  fDate: string;
  eventMs: number;
  deviceId: number;
}

export function rowToPunch(r: Record<string, unknown>): Punch {
  return {
    id: Number(r['id']),
    employeeId: Number(r['employee_id']),
    afm: String(r['afm']),
    surname: String(r['surname']),
    firstName: String(r['first_name']),
    branch: String(r['branch']),
    fType: String(r['f_type']) as CardEventType,
    referenceDate: String(r['reference_date']),
    fDate: String(r['f_date']),
    eventMs: Number(r['event_ms']),
    deviceId: Number(r['device_id']),
  };
}

/** The person's most recent card, at any branch, if any. */
export function lastPunchOf(db: StampStore, employeeId: number): Punch | undefined {
  const r = db.prepare('SELECT * FROM punches WHERE employee_id = ? ORDER BY event_ms DESC, id DESC LIMIT 1').get(employeeId);
  return r === undefined ? undefined : rowToPunch(r);
}

/** An ΕΝΑΡΞΗ with no ΛΗΞΗ after it yet, today or on yesterday's supported overnight shift — the shift a ΛΗΞΗ now would close. */
export function openShiftOf(db: StampStore, employeeId: number, nowMs: number): Punch | undefined {
  const last = lastPunchOf(db, employeeId);
  if (last === undefined || last.fType !== ENARXI) return undefined;
  const t = athensTime(nowMs);
  if (last.referenceDate === t.date) return last;
  if (last.referenceDate === addDays(t.date, -1)) {
    if (t.time < AFTER_MIDNIGHT_UNTIL) return last;
    const recorded = reminderDay(db, last.referenceDate, employeeId, last.branch);
    // A known overnight end may be later than 06:00. Include the ending instant, but never borrow another person's,
    // day's or branch's hours to turn an unrelated next-morning departure into yesterday's shift.
    if (recorded.intervals?.some((iv) => iv.end < iv.start && nowMs <= athensInstant(t.date, iv.end))) return last;
  }
  return undefined;
}

/** The person's last card, if it belongs to today's working day or is still open — what the board shows beside the name. */
export function currentCardOf(db: StampStore, employeeId: number, nowMs: number): Punch | undefined {
  const last = lastPunchOf(db, employeeId);
  if (last === undefined) return undefined;
  return last.referenceDate === athensTime(nowMs).date || openShiftOf(db, employeeId, nowMs) !== undefined ? last : undefined;
}

/** What the page highlights: ΛΗΞΗ while a shift is open, ΕΝΑΡΞΗ otherwise. The person still chooses. */
export function suggestedType(db: StampStore, employeeId: number, nowMs: number): CardEventType {
  return openShiftOf(db, employeeId, nowMs) === undefined ? ENARXI : LIXI;
}

/** The working day a card of `fType` made now belongs to. */
export function referenceDateFor(db: StampStore, employeeId: number, fType: CardEventType, nowMs: number): string {
  if (fType === LIXI) {
    const open = openShiftOf(db, employeeId, nowMs);
    if (open !== undefined) return open.referenceDate;
  }
  return athensTime(nowMs).date;
}

/**
 * Write the card, committed, and return it. The caller wakes the outbox afterwards.
 * ⛔ Takes a `VerifiedPerson`, which only a checked PIN produces; and the enrolled device it was made on, whose branch
 * the card is.
 */
export function capturePunch(
  db: StampStore,
  who: VerifiedPerson,
  fType: CardEventType,
  device: Pick<Device, 'id' | 'branch'>,
  nowMs: number,
): Punch {
  // ⛔ At run time too, not only in the type: nothing but a PIN-checked person reaches the INSERT below.
  if (!VerifiedPerson.is(who)) throw new Error('only a checked PIN makes a card.');
  const person = db.prepare('SELECT afm, surname, first_name, must_stamp, active FROM employees WHERE id = ?').get(who.employeeId);
  if (person === undefined || person['active'] !== 1 || person['must_stamp'] !== 1) {
    throw new Error('this person is not on the list of people who stamp here.');
  }
  const referenceDate = referenceDateFor(db, who.employeeId, fType, nowMs);
  const row = db
    .prepare(
      `INSERT INTO punches (employee_id, afm, surname, first_name, branch, f_type, reference_date, f_date, event_ms, device_id,
                            created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      who.employeeId,
      String(person['afm']),
      String(person['surname']),
      String(person['first_name']),
      device.branch,
      fType,
      referenceDate,
      cardDateTime(nowMs),
      nowMs,
      device.id,
      isoOf(nowMs),
    );
  if (row === undefined) throw new Error('the card was not written.');
  return rowToPunch(row);
}
