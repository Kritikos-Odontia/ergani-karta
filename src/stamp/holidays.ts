// SPDX-License-Identifier: EUPL-1.2
import { addDays } from './athens.js';

/** Orthodox Easter: Julian computus, then Gregorian conversion. No external service or annual table. */
export function orthodoxEaster(year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 2199) throw new RangeError('Το έτος πρέπει να είναι από 1900 έως 2199.');
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = (d + e + 114) % 31 + 1;
  const offset = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

/** National dates, per the Labour Inspectorate list linked in docs/ACCOUNTANT-CALENDAR.md.
 * Exceptional transfers (notably May Day) and local holidays need an owner mark; never guess a decree.
 */
export function nationalHolidays(year: number): Array<{ day: string; name: string }> {
  const easter = orthodoxEaster(year);
  const fixed = [ ['01-01', 'Πρωτοχρονιά'], ['01-06', 'Θεοφάνια'], ['03-25', '25η Μαρτίου'], ['05-01', 'Πρωτομαγιά'],
    ['08-15', 'Κοίμηση της Θεοτόκου'], ['10-28', '28η Οκτωβρίου'], ['12-25', 'Χριστούγεννα'], ['12-26', '26η Δεκεμβρίου'] ];
  return [...fixed.map(([date, name]) => ({ day: `${year}-${date}`, name: name! })),
    { day: easter, name: 'Πάσχα' }, { day: addDays(easter, 1), name: 'Δευτέρα του Πάσχα' }].sort((a, b) => a.day.localeCompare(b.day));
}

export function nationalHoliday(day: string): string | undefined {
  const year = Number(day.slice(0, 4));
  if (year < 1900 || year > 2199) return undefined;
  return nationalHolidays(year).find((h) => h.day === day)?.name;
}
