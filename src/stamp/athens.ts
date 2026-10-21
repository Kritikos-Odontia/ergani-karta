// SPDX-License-Identifier: EUPL-1.2
/**
 * Athens wall-clock time, for the cards. ⚠ Every date and time a card carries is ATHENS time, with its offset — the
 * working day and the 15-minute wall are the clinic's, and at 00:30 Athens it is still the previous day in UTC.
 * ⓘ Never the browser's clock: the instant of a card is the server's clock (kept right by NTP) at «Επιβεβαίωση».
 */

const ATHENS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Athens',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface AthensTime {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM:SS` */
  time: string;
  /** `+03:00` in summer, `+02:00` in winter. */
  offset: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export function athensTime(ms: number): AthensTime {
  const p = Object.fromEntries(ATHENS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const offset = (p['timeZoneName'] ?? 'GMT').replace('GMT', '') || '+00:00';
  return {
    date: `${p['year']}-${p['month']}-${p['day']}`,
    time: `${p['hour']}:${p['minute']}:${p['second']}`,
    offset,
    weekday: WEEKDAYS[p['weekday'] ?? ''] ?? -1,
  };
}

/**
 * `f_date` as the card carries it: `YYYY-MM-DDTHH:MM:SS+03:00` — an `xs:dateTime` (Card_v1.xsd) in the form of the
 * ministry's own example (`WorkCard_2submissions.json`, «2022-05-13T09:00:00.7099109+03:00»), without the fraction.
 */
export function cardDateTime(ms: number): string {
  const t = athensTime(ms);
  return `${t.date}T${t.time}${t.offset}`;
}

/** `DD/MM HH:MM` — how a person reads a card's time on the page and on the phone. */
export function shortGreek(ms: number): string {
  const t = athensTime(ms);
  return `${t.date.slice(8, 10)}/${t.date.slice(5, 7)} ${t.time.slice(0, 5)}`;
}

/** `HH:MM`. */
export function clockOf(ms: number): string {
  return athensTime(ms).time.slice(0, 5);
}

/**
 * The instant of an Athens wall-clock reading (`YYYY-MM-DD`, `HH:MM` or `HH:MM:SS`). The offset is found by asking the
 * calendar, twice, so a summer/winter change in between is honoured. ⓘ For the hour that does not exist (spring
 * forward), the answer lands one hour later; for the hour that happens twice, the later (winter time). Neither is
 * a clinic hour.
 */
export function athensInstant(date: string, time: string): number {
  const [h = 0, m = 0, s = 0] = time.split(':').map(Number);
  const naive = Date.parse(`${date}T00:00:00Z`) + ((h * 60 + m) * 60 + s) * 1000;
  let guess = naive - offsetMs(naive);
  guess = naive - offsetMs(guess);
  return guess;
}

function offsetMs(ms: number): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(athensTime(ms).offset);
  if (m === null) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** `YYYY-MM-DD` plus `days` (may be negative), on the calendar. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
