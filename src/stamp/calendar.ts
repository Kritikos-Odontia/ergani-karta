// SPDX-License-Identifier: EUPL-1.2
import { daysBetween } from '../export/model.js';
import { inTransaction } from '../records/store.js';
import { isoOf, type StampStore } from './store.js';

export interface Interval { start: string; end: string }

export function calendarDays(from: string, to: string): string[] {
  // Bound before enumerating: a form must not allocate centuries of dates.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      Date.parse(`${to}T00:00Z`) - Date.parse(`${from}T00:00Z`) > 366 * 86_400_000) {
    throw new Error('Δώστε πραγματικές ημερομηνίες και περίοδο έως ένα έτος.');
  }
  return daysBetween(from, to);
}

export function parseHours(text: string): Interval[] {
  const intervals = text.split(',').map((part) => {
    const match = /^\s*([0-2]\d:[0-5]\d)\s*-\s*([0-2]\d:[0-5]\d)\s*$/.exec(part);
    if (match === null || match[1]! >= '24:00' || match[2]! >= '24:00' || match[1] === match[2]) {
      throw new Error('Ώρες όπως 09:00-13:00,17:00-21:00.');
    }
    return { start: match[1]!, end: match[2]! };
  }).sort((a, b) => a.start.localeCompare(b.start));
  // Only the last interval may cross midnight. An interval ending at its start is never a 24-hour shift.
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i]!;
    if (i < intervals.length - 1 && (iv.end < iv.start || iv.end > intervals[i + 1]!.start)) throw new Error('Οι βάρδιες δεν πρέπει να επικαλύπτονται.');
  }
  return intervals;
}

export function markCalendar(db: StampStore, input: {
  from: string; to: string; employeeId: number; branch?: string | undefined;
  kind: 'leave' | 'hours' | 'reset'; hours?: string | undefined; reason: string;
}, by: string, nowMs: number): void {
  const days = calendarDays(input.from, input.to);
  if (!Number.isSafeInteger(input.employeeId) || db.prepare('SELECT id FROM employees WHERE id = ?').get(input.employeeId) === undefined) throw new Error('Διαλέξτε εργαζόμενο.');
  if (input.reason.trim() === '' || input.reason.length > 500 || by.trim() === '') throw new Error('Γράψτε σύντομο λόγο.');
  if (input.branch !== undefined && db.prepare('SELECT code FROM branches WHERE code = ?').get(input.branch) === undefined) throw new Error('Διαλέξτε παράρτημα.');
  if (input.kind === 'leave' && input.branch !== undefined) throw new Error('Για άδεια διαλέξτε Όλα τα παραρτήματα.');
  if (input.kind === 'hours' && input.branch === undefined) throw new Error('Διαλέξτε παράρτημα για τις ώρες.');
  const intervals = input.kind === 'hours' ? parseHours(input.hours ?? '') : [];
  inTransaction(db, () => {
    const insert = db.prepare('INSERT INTO reminder_calendar (day, employee_id, branch, kind, intervals, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const day of days) insert.run(day, input.employeeId, input.branch ?? null, input.kind, JSON.stringify(intervals), input.reason.trim(), by, isoOf(nowMs));
  });
}

/** Leave is personal across branches; replacement hours are per branch. A reset restores the normal source. */
export function reminderDay(db: StampStore, day: string, employeeId: number, branch: string): { off: boolean; intervals: Interval[] | undefined; revision?: number } {
  const leave = db.prepare('SELECT kind FROM reminder_calendar WHERE day = ? AND employee_id = ? AND branch IS NULL ORDER BY id DESC LIMIT 1').get(day, employeeId);
  if (leave?.['kind'] === 'leave') return { off: true, intervals: [] };
  const row = db.prepare('SELECT id, kind, intervals FROM reminder_calendar WHERE day = ? AND employee_id = ? AND branch = ? ORDER BY id DESC LIMIT 1').get(day, employeeId, branch);
  return row?.['kind'] === 'hours' ? { off: false, intervals: JSON.parse(String(row['intervals'])) as Interval[], revision: Number(row['id']) } : { off: false, intervals: undefined };
}
