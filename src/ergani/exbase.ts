// SPDX-License-Identifier: EUPL-1.2
import type { z } from 'zod';
import type { ErganiClient } from './client.js';
import { BranchAa, ScheduleRow, StampRow } from './types.js';

/**
 * THE EX_BASE READ CLIENT — the employer's own clock-in records, read back out of ΕΡΓΑΝΗ, one reference
 * date per call, for the read-only monthly archive.
 *
 * ── ⛔ IT CANNOT WRITE ─────────────────────────────────────────────────────────────────────────────
 * Every function here takes a `ReadClient`: the client narrowed to the service catalogue, the service
 * call, its clock and its branch. The filing method is not part of that type, so nothing written here
 * can reach it — the fence is the compiler, not a convention.
 *
 * ── ⛔⛔ THE ONE-MONTH WINDOW IS REFUSED HERE, BEFORE A BYTE LEAVES ────────────────────────────────
 * «Περιορισμός σε ημ/νιες προηγούμενου μήνα και πίσω» — and ENFORCED, measured on both sides of the
 * line on 2026-09-24: 24/09 and 01/09 answered HTTP 400 «Criteria doesn't meet requirements»; 31/08 and
 * 15/07 answered 200. `assertReadableDate` refuses the current Athens month and later locally, because:
 * (1) it turns an opaque Greek 400 into something a human can act on; (2) the window is a property of the
 * service, not a failure; (3) a caller that retries a 400 cannot exist if the 400 is never provoked.
 * ⛔ A date is never clamped to the nearest readable one: a silently moved date files a record under the
 * wrong month, which is worse than an error.
 * ⓘ No lower bound is enforced HERE: ΕΡΓΑΝΗ keeps card data six months, and what it answers for an older
 * date has not been measured. The monthly pull refuses a month six or more months back (`pull.ts`).
 *
 * ── ⚠⚠ TWO THINGS NOBODY HAS SEEN — so a wrong guess is LOUD, never an empty month ─────────────────
 * The first probe (2026-09-24) saw zero rows and did not record (a) the NAME of the Date parameter, or (b) the KEY
 * that holds the rows. So (a) is read at run time from the service's own `ServicesList` declaration,
 * and (b) is found by position in the documented pattern, never by name. ⛔⛔ An answer this code
 * cannot recognise is an `UnrecognisedAnswerError`, never zero rows: the archive's one job is to hold
 * every stamp for five years, and a shape mismatch that reads as «nobody stamped this month» is the
 * worst failure it could ship.
 *
 * ⛔ `EX_BASE_05` and `06` are entitled but return personal details; nothing here calls them.
 */

/** `EX_BASE_07` — ΗΜΕΡΟΛΟΓΙΟ ΠΡΑΓΜΑΤΙΚΗΣ ΑΠΑΣΧΟΛΗΣΗΣ: the stamps. */
export const STAMPS_SERVICE = 'EX_BASE_07';

/** `EX_BASE_08` — ΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ ΨΟΧΕ: the declared schedule and leave. */
export const SCHEDULE_SERVICE = 'EX_BASE_08';

/** The branch parameter both services declare (measured 2026-09-24: declared `Int` by ServicesList). */
export const BRANCH_PARAMETER = 'PararthmaAa';

/** The ministry's own words for the window, as its parameter documentation carries them. */
export const READ_WINDOW_RULE = 'Περιορισμός σε ημ/νιες προηγούμενου μήνα και πίσω';

/**
 * ServicesList's parameter type for a date: the guide shows `type` both as a word (`"Int"` in its
 * example) and as a number («Date = 2» in its list), §2.1.9. Either is accepted; nothing else is.
 */
const DATE_TYPES: readonly unknown[] = ['Date', 2];

/** What a read needs of the client — and, by leaving the filing method out, all it can reach. */
export type ReadClient = Pick<ErganiClient, 'listServices' | 'executeService' | 'now' | 'branchCode'>;

/** The asked date is in the current Athens month or later — ΕΡΓΑΝΗ would refuse it. Nothing was sent. */
export class OutOfWindowError extends Error {
  /** `YYYY-MM-DD`, as asked. */
  readonly date: string;
  /** `YYYY-MM-DD`, the Athens calendar date the window was judged against. */
  readonly today: string;
  /** `YYYY-MM-DD`, the last day of the previous month — the latest date ΕΡΓΑΝΗ will answer for today. */
  readonly latestReadable: string;

  constructor(date: string, today: string, latestReadable: string) {
    super(
      `Not sent: ΕΡΓΑΝΗ answers these reads only for dates in the previous month or earlier ` +
        `(«${READ_WINDOW_RULE}»), and refuses anything later with HTTP 400. ${wireDate(date)} is not ` +
        `before this month — today in Athens is ${wireDate(today)} — so the latest date that can be ` +
        `read today is ${wireDate(latestReadable)}.`,
    );
    this.name = 'OutOfWindowError';
    this.date = date;
    this.today = today;
    this.latestReadable = latestReadable;
  }
}

/**
 * The service's ServicesList entry is missing, or declares parameters other than `PararthmaAa` plus
 * exactly one Date. Nothing was sent: guessing a parameter name risks an answer that reads as an empty
 * day when the day was never asked about.
 */
export class ServiceDeclarationError extends Error {
  readonly serviceCode: string;

  constructor(serviceCode: string, problem: string) {
    super(`${serviceCode}: ${problem}. Nothing was read.`);
    this.name = 'ServiceDeclarationError';
    this.serviceCode = serviceCode;
  }
}

/**
 * ΕΡΓΑΝΗ answered 200 with something this reader does not recognise. ⛔ Never zero rows.
 * ⓘ The message describes the SHAPE — keys, kinds, field names — never a value: a value here is a
 * person's ΑΦΜ or working hours.
 */
export class UnrecognisedAnswerError extends Error {
  readonly serviceCode: string;

  constructor(serviceCode: string, problem: string) {
    super(
      `${serviceCode}: the answer is not in a shape this reader recognises — ${problem}. Nothing was ` +
        `read: an answer that cannot be recognised is never taken as a day with no records.`,
    );
    this.name = 'UnrecognisedAnswerError';
    this.serviceCode = serviceCode;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The two reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `EX_BASE_07` for ONE reference date (`YYYY-MM-DD`): the stamps, one row per employee per day.
 *
 * ⛔ Every row must carry the date that was asked for. What the Date parameter MEANS is unmeasured: if
 * ΕΡΓΑΝΗ read it as «from» rather than «on», or ignored it, every day of a month would answer the same
 * stamps, and the record — which can never delete a row — would hold each one under every day. So an
 * answer holding a row for another day, or a Date in a form not recognised here, is refused whole.
 * Recognised: `DD/MM/YYYY` (the form the services were measured to take) and `YYYY-MM-DD`, bare or
 * followed by `T00:00:00`. A branch the row names (`aa` or `Aa`) must be the branch asked for.
 */
export async function readStamps(client: ReadClient, date: string): Promise<StampRow[]> {
  const rows = await read(client, STAMPS_SERVICE, date, StampRow);
  assertRowsAreFor(STAMPS_SERVICE, rows, date, client.branchCode, (row) => [row.aa, row.Aa]);
  return rows;
}

/**
 * Refuse the whole answer unless every row names the day asked for (`Date`) and, where it names one,
 * the branch asked for — the reason is `readStamps`' docblock: the record can never delete a row, so a
 * row filed under the wrong day or branch would stand there for five years.
 */
function assertRowsAreFor<Row extends { Date: string }>(
  serviceCode: string,
  rows: readonly Row[],
  date: string,
  branchCode: string,
  branchesOf: (row: Row) => Array<string | undefined>,
): void {
  const branch = pararthmaAaOf(branchCode);
  const strayDay = rows.findIndex((row) => calendarDayOf(row.Date) !== date);
  if (strayDay !== -1) {
    throw new UnrecognisedAnswerError(
      serviceCode,
      `row ${strayDay} carries a Date that is not the day asked for, or is not in a recognised form`,
    );
  }
  const strayBranch = rows.findIndex((row) =>
    branchesOf(row).some((named) => named !== undefined && String(Number(named)) !== branch),
  );
  if (strayBranch !== -1) {
    throw new UnrecognisedAnswerError(serviceCode, `row ${strayBranch} names a branch that is not the one asked for`);
  }
}

/** The `YYYY-MM-DD` a row's Date names, or `undefined` for a form this reader does not recognise. */
function calendarDayOf(text: string): string | undefined {
  const greek = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (greek !== null) return `${greek[3]}-${greek[2]}-${greek[1]}`;
  return /^(\d{4}-\d{2}-\d{2})(T00:00:00)?$/.exec(text)?.[1];
}

/**
 * `EX_BASE_08` for ONE reference date (`YYYY-MM-DD`): the declared schedule and leave.
 * ⓘ MEASURED (2026-09-28): its rows DO carry `Date` and `aa` (see `ScheduleRow`), and on every day read the
 * Date was the day asked for — the parameter means «on». So the stamps' check applies here too.
 * ⓘ `noStandingSchedule`: the employer has said this branch declares no standing schedule
 * (`STAMP_BRANCH_<n>_SCHEDULE=none`). For such a branch ΕΡΓΑΝΗ answers a bare `null` (measured, see
 * `NULL_MEANS_NO_ROWS`), and only then is it read as a day with no declared rows. Anywhere else a `null` from
 * EX_BASE_08 is refused, so a branch that should have a schedule never silently reads as having none.
 */
export async function readSchedule(
  client: ReadClient,
  date: string,
  options: { noStandingSchedule?: boolean } = {},
): Promise<ScheduleRow[]> {
  const rows = await read(client, SCHEDULE_SERVICE, date, ScheduleRow, options.noStandingSchedule === true);
  assertRowsAreFor(SCHEDULE_SERVICE, rows, date, client.branchCode, (row) => [row.aa]);
  return rows;
}

/**
 * One call per date because every measured call was per date (24/09, 01/09, 31/08, 15/07); a caller
 * walks a month's days. «Today» is the client's injected clock, read in Athens — never the wall clock.
 */
async function read<Row extends z.ZodTypeAny>(
  client: ReadClient,
  serviceCode: string,
  date: string,
  row: Row,
  nullMeansNoRows = NULL_MEANS_NO_ROWS.has(serviceCode),
): Promise<Array<z.output<Row>>> {
  // First, before ServicesList or authentication: an out-of-window date sends nothing at all.
  assertReadableDate(date, athensDate(client.now()));
  const dateParameter = await dateParameterOf(client, serviceCode);
  // §2.1.10's body; `executeService` spreads this beside `ServiceCode`.
  const answer = await client.executeService(serviceCode, {
    Parameters: [
      { ParameterName: dateParameter, ParameterValue: wireDate(date) },
      { ParameterName: BRANCH_PARAMETER, ParameterValue: pararthmaAaOf(client.branchCode) },
    ],
  });
  return rowsIn(serviceCode, answer, row, nullMeansNoRows);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The window, on the Athens calendar
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Throw `OutOfWindowError` unless ΕΡΓΑΝΗ will answer for `date` on `today` — both `YYYY-MM-DD`, `today`
 * being the ATHENS calendar date (see `athensDate`). Readable means: in a month before today's month.
 */
export function assertReadableDate(date: string, today: string): void {
  const asked = calendarDate(date, 'date');
  const now = calendarDate(today, 'today');
  if (asked.year * 12 + asked.month < now.year * 12 + now.month) return;
  // Day 0 of today's month is the last day of the month before it.
  const latest = new Date(Date.UTC(now.year, now.month - 1, 0)).toISOString().slice(0, 10);
  throw new OutOfWindowError(date, today, latest);
}

const ATHENS_CALENDAR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Athens',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Athens calendar date (`YYYY-MM-DD`) of an instant. ⚠ "This month" is Athens's, not UTC's: at 00:30
 * Athens on the 1st it is still the previous day in UTC, and a UTC reading would refuse a date ΕΡΓΑΝΗ
 * already answers for.
 */
export function athensDate(instant: number): string {
  const part = (type: string) =>
    ATHENS_CALENDAR.formatToParts(new Date(instant)).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function calendarDate(text: string, what: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (m === null || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`${what} must be a calendar date written YYYY-MM-DD`);
  }
  return { year, month };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What goes on the wire
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` → `DD/MM/YYYY`, the only date form the services were measured to accept (2026-09-24). */
function wireDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * The branch as the read services take it. `config.branchCode` is `f_aa` — a STRING of 1–5 digits
 * (`Card_v1.xsd`); ServicesList declares `PararthmaAa` an `Int`; and every documented `ParameterValue`
 * is a string. ⇒ The integer written in decimal digits, leading zeros dropped: `"0"` stays `"0"`.
 * The one conversion between the two, in one place.
 */
export function pararthmaAaOf(branchCode: string): string {
  return String(Number(BranchAa.parse(branchCode)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading ServicesList: the Date parameter's name, never guessed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ServicesList, fetched once per client and reused for every date of a run: a month's walk would
 * otherwise ask for the same catalogue sixty times, and the ministry limits «το σύνολο των κλήσεων»
 * (Παράρτημα ΙΙ §3). A failed fetch is forgotten, so the next read asks again.
 */
const catalogues = new WeakMap<ReadClient, Promise<unknown>>();

function catalogueOf(client: ReadClient): Promise<unknown> {
  const held = catalogues.get(client);
  if (held !== undefined) return held;
  const pending = client.listServices();
  catalogues.set(client, pending);
  pending.catch(() => {
    if (catalogues.get(client) === pending) catalogues.delete(client);
  });
  return pending;
}

/**
 * The name of `serviceCode`'s Date parameter, as its ServicesList entry declares it (§2.1.9 shape:
 * `{name, parameters: [{name, type, …}]}`). Expected: `PararthmaAa` and exactly one Date-typed entry.
 * Anything else is refused, naming what was found.
 */
async function dateParameterOf(client: ReadClient, serviceCode: string): Promise<string> {
  const catalogue = await catalogueOf(client);
  if (!Array.isArray(catalogue)) {
    throw new ServiceDeclarationError(serviceCode, `ServicesList answered ${kindOf(catalogue)}, not a list of services`);
  }
  const service: unknown = catalogue.find((s) => isRecord(s) && s['name'] === serviceCode);
  if (!isRecord(service)) {
    throw new ServiceDeclarationError(
      serviceCode,
      'not in ServicesList — the signed-in user is not entitled to this service',
    );
  }
  const declared = service['parameters'];
  if (!Array.isArray(declared) || !declared.every((p) => isRecord(p) && typeof p['name'] === 'string')) {
    throw new ServiceDeclarationError(serviceCode, 'ServicesList declares its parameters in an unrecognised form');
  }
  const parameters = declared as Array<{ name: string; type?: unknown }>;
  const branch = parameters.filter((p) => p.name === BRANCH_PARAMETER);
  const others = parameters.filter((p) => p.name !== BRANCH_PARAMETER);
  const [date] = others;
  if (branch.length !== 1 || others.length !== 1 || date === undefined || !DATE_TYPES.includes(date.type)) {
    const found = parameters.map((p) => `${p.name} (type ${JSON.stringify(p.type) ?? 'missing'})`).join(', ');
    throw new ServiceDeclarationError(
      serviceCode,
      `ServicesList was expected to declare ${BRANCH_PARAMETER} and exactly one Date parameter, and declares [${found}]`,
    );
  }
  return date.name;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading the answer: the documented pattern, not a guessed key
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The rows of an ExecuteService answer, in the documented pattern (§2.1.10): the service code as the
 * only top key, holding ONE key — whatever it is called — whose value is the rows.
 *
 *   · `{"EX_BASE_07": {"<any>": [row, …]}}` → the rows.
 *   · `{"EX_BASE_07": {"<any>": {row}}}` → one row. The guide's only two read examples, EX_BASE_01 and
 *     EX_BASE_04, each show a single record as a bare object, not a one-element list.
 *   · `{"EX_BASE_07": {"<any>": []}}` or `{"EX_BASE_07": {}}` → ZERO ROWS, recognisably: the service key
 *     is present and holds nothing.
 *   · a bare `null` → ZERO ROWS, for `EX_BASE_07` (`NULL_MEANS_NO_ROWS`), and for `EX_BASE_08` only on a branch
 *     the employer says declares no standing schedule (`readSchedule`).
 *   · anything else → `UnrecognisedAnswerError`, and so is ANY row that fails `row` — the whole answer is
 *     refused, never a partial day.
 */
function rowsIn<Row extends z.ZodTypeAny>(
  serviceCode: string,
  answer: unknown,
  row: Row,
  nullMeansNoRows: boolean,
): Array<z.output<Row>> {
  const refuse = (problem: string) => new UnrecognisedAnswerError(serviceCode, problem);
  if (answer === null && nullMeansNoRows) return [];
  if (!isRecord(answer)) throw refuse(`it is ${kindOf(answer)}, not an object`);
  const top = Object.keys(answer);
  if (top.length !== 1 || top[0] !== serviceCode) {
    throw refuse(`expected the single top-level key "${serviceCode}", found [${top.join(', ')}]`);
  }
  const inner = answer[serviceCode];
  if (!isRecord(inner)) throw refuse(`"${serviceCode}" holds ${kindOf(inner)}, not an object`);
  const keys = Object.keys(inner);
  const [key] = keys;
  if (key === undefined) return [];
  if (keys.length > 1) throw refuse(`"${serviceCode}" holds ${keys.length} keys [${keys.join(', ')}], not the one that holds the rows`);

  const held = inner[key];
  const where = `${serviceCode}.${key}`;
  const list: unknown[] | undefined = Array.isArray(held) ? held : isRecord(held) ? [held] : undefined;
  if (list === undefined) throw refuse(`"${where}" holds ${kindOf(held)}, not rows`);
  return list.map((item, i) => {
    const parsed = row.safeParse(item);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the row'}: ${issue.message}`);
      throw refuse(`row ${i} of "${where}" — ${issues.join('; ')}`);
    }
    return parsed.data as z.output<Row>;
  });
}

/**
 * ⭐ MEASURED 2026-09-28, production, the scoped user: `EX_BASE_07` for a day with no stamps answers
 * HTTP 200, `application/json`, the four characters `null` — on 03/08 and on 15/07/2026, while
 * `EX_BASE_08` answered the SAME days with full rows, so it is neither a refused service nor a bad
 * parameter. Both days were already known empty (the portal's own calendar).
 * ⓘ MEASURED too (a real account, 2026-09-29 and 2026-10-07): `EX_BASE_08` answers a bare `null` for a branch on which
 * no schedule was ever declared. It is read as no rows only where the employer has said so (`readSchedule`); from any
 * other branch a `null` is still refused.
 * ⛔ The literal `null` only. An empty body (an empty 200, a 204) has never been observed; the client
 * hands it over as `undefined`, and it is refused like any other unrecognised answer.
 * ⚠ A `null` for a day ΕΡΓΑΝΗ has already purged would read the same way — which is why a pull never
 * asks for a month older than five (`RETENTION_MONTHS`, records/pull.ts; docs/DECISIONS.md).
 */
const NULL_MEANS_NO_ROWS: ReadonlySet<string> = new Set([STAMPS_SERVICE]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What kind of JSON value this is — never the value itself. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
