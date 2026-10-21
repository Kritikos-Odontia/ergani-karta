// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Secret, type Config } from '../../src/config.js';

/**
 * A LOCAL HTTP FAKE OF THE ΕΡΓΑΝΗ ΙΙ API, built from the ministry's own published bytes.
 *
 * ── ⛔⛔ WHAT THIS CANNOT PROVE ───────────────────────────────────────────────────────────────────
 * A fake proves we speak the **documented** protocol. It cannot prove the live system behaves as
 * documented. It removes the credential from everything that does not need the real system.
 * ⛔ A green suite is therefore NOT evidence that the integration works. Only a real call answers
 * that, and every real call is a deliberate step by the employer (docs/INSTALL.md).
 *
 * ── WHAT IT IS BUILT FROM ──────────────────────────────────────────────────────────────────────
 *   · the card's rules — read at start-up from the vendored `test/fixtures/ministry/Card_v1.xsd`,
 *     not transcribed, so the fake and the evidence cannot drift apart (see `validateCardPayload`);
 *   · the routes, bodies and failures — the interoperability guide «Σύστημα Εκτέλεσης Υπηρεσιών
 *     Διαλειτουργικότητας», 18.02.2026, §2.1.1–§2.1.10 and Παράρτημα ΙΙ;
 *   · what the guide does not say — a read-only production probe of one employer's account on 2026-09-24
 *     (the active forms, the read services it is entitled to, its branch, the date window), and the
 *     reads and filings measured after it.
 * Provenance of the vendored files: `test/fixtures/ministry/PROVENANCE.md`.
 *
 * ── ⚠⚠ WHAT IT INVENTS — UNMEASURED, and a guess must never be read as the ministry's ─────────────
 * The 2026-09-24 probe saw ZERO `EX_BASE_07/08` rows and recorded neither of these:
 *   (a) the NAME of the Date parameter → `UNMEASURED_DATE_PARAMETER`;
 *   (b) the KEY that holds the rows under the service code → `UNMEASURED_ROWS_KEY` — and with it
 *       the shape of an empty answer, and whether a single row arrives as a one-element array (the
 *       fake's choice) or as a bare object (which is what the guide's only two examples, EX_BASE_01
 *       and EX_BASE_04, each show).
 * Both placeholders are deliberately unlike a real name, and both can be moved per instance, so a
 * reader proves it learns them rather than hard-coding them. And, less loudly but just as unmeasured:
 *   (c) the VALUE formats inside a row (`DD/MM/YYYY`, `HH:mm`, `"0"`/`"1"` flags, `""` for no hours) —
 *       only the field NAMES were recorded;
 *   (d) `Afm` on an `EX_BASE_08` row — not in the recorded field list, inferred from «per employee
 *       per day»; and `Type` carrying the guide's §4 codes (`ΕΡΓ`, `ΑΔΠΠΜ`).
 * ⭐ 2026-09-28, the first real reads (a restricted user, production) settled most of this: both services
 * name the Date parameter `Date`; EX_BASE_08 keeps its rows under `Working`, in the row shape now served
 * here (d confirmed, formats in `FakeScheduleRow`); EX_BASE_07 answers a day with no stamps with a bare
 * `null`, now served here too. Still unseen: any EX_BASE_07 row, and its rows key. The placeholders
 * stay placeholders on purpose — they prove a reader learns the names from ServicesList.
 *
 * ── WHERE THE MINISTRY IS SILENT, THE FAKE IS STRICT, AND SAYS SO ────────────────────────────────
 * Every message the fake makes up starts `ergani-fake:`. Every other message is quoted from the guide
 * or was measured, and says which beside its constant. The strict choices: a leaf value must be a
 * JSON string (every ministry example quotes it) or `null` (§2.1.6's own request sends
 * `"f_aitiologia": null` despite `nillable="false"`, so null is read as an empty value); an unknown
 * or missing ExecuteService parameter is refused rather than answered with zero rows; a wrong
 * credential is a 401. JSON key order is not checked — JSON objects are unordered (RFC 8259).
 *
 * ⛔ Served on 127.0.0.1 only, which the live-call fence (`test/setup.ts`) deliberately allows; the
 * fence is untouched. ⛔ Every ΑΦΜ here is one of the ministry's own published example values (which fail the
 * check digit, so none can be a real one) or fabricated (test/fixtures/people.ts).
 *
 * ── ONE LOGIN PER BRANCH ─────────────────────────────────────────────────────────────────────────
 * A Χρήστης Παραρτήματος acts for its own branch (the ministry's CardScanner guide). How ΕΡΓΑΝΗ answers a login
 * that files or reads for another branch is UNMEASURED. Given `branchLogins` — one login per branch — the fake is
 * strict and refuses it (`ergani-fake:`), so a test proves each card goes out with its own branch's login. Without
 * it, the one credential stands for the employer itself and may file any branch, as the ministry's own two-branch
 * example does.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Measured and documented facts
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirrors the real base's path, `…/WebservicesAPI/api` (config.ts `ERGANI_BASE_URLS`). */
export const FAKE_API_PATH = '/WebservicesAPI/api';

/**
 * The fake's default clock: 10:00 Athens on 24/09/2026, inside the window in which the read-only probe
 * ran (09:50–10:20). ⚠ The fake NEVER reads the wall clock — a window check against the real date
 * would make the suite pass or fail depending on the day it runs.
 */
export const MEASURED_NOW = Date.parse('2026-09-24T10:00:00+03:00');

/** The employer of guide §2.1.6's own request example — a ministry example value, not a real ΑΦΜ. */
export const FAKE_EMPLOYER_AFM = '012345678';

/** The seat (έδρα) is branch `"0"`; a single-branch employer has only it (measured 2026-09-24). */
export const FAKE_BRANCH = '0';

/** Fabricated. Within the ministry's 8–20 / 8–12 bounds so a `Config` can carry it. */
export const FAKE_CREDENTIAL = { username: 'fixture01', password: 'Fixture.p1', usertype: '02' } as const;

/** Seconds — guide §2.1.1, Παράρτημα ΙΙ §2, and measured live (2026-09-24). */
export const ACCESS_TOKEN_LIFETIME_S = 10_800;

/** Seven days — Παράρτημα ΙΙ §2. */
const REFRESH_TOKEN_LIFETIME_MS = 7 * 86_400_000;

/** The documented expiry signal (§2.1.1), sent with the 401 of Παράρτημα ΙΙ §2. */
const TOKEN_EXPIRED_HEADER = 'api-token-expired';

/**
 * `GET /Lookup/Submissions` for one employer, as measured on 2026-09-24: `WRKCardSE` is **184**, not
 * the guide's example 82. The other three ids were measured too; their descriptions were not
 * recorded and are left out rather than invented. ⓘ `WRKCardSE` is deliberately not first: code
 * looks a form up by its `code`, never by position or id.
 */
const SUBMISSIONS = [
  { id: 205, code: 'SixthDay' },
  { id: 184, code: 'WRKCardSE', description: 'Δήλωση έναρξης/λήξης εργασίας εργαζομένων' },
  { id: 207, code: 'WTODailyA' },
  { id: 233, code: 'WTOOvA' },
];

/** `GET /Documents/WRKCardSE` — the schema body of guide §2.1.5: two Cards of two details each. */
const WORK_CARD_SCHEMA = (() => {
  const detail = {
    f_afm: 'f_afm',
    f_eponymo: 'f_eponymo',
    f_onoma: 'f_onoma',
    f_type: '0',
    f_reference_date: '2022-05-13',
    f_date: '2022-05-13T09:21:37.4578278+03:00',
    f_aitiologia: 'f_aitiologia',
  };
  const card = {
    f_afm_ergodoti: 'f_afm_ergodoti',
    f_aa: 'f_aa',
    f_comments: 'f_comments',
    Details: { CardDetails: [detail, detail] },
  };
  return { Cards: { Card: [card, card] } };
})();

/** One employer's entitlement, measured 2026-09-24. ⛔ `EX_BASE_04` is absent on purpose. */
export const MEASURED_ENTITLEMENT = [
  'EX_BASE_01',
  'EX_BASE_02',
  'EX_BASE_03',
  'EX_BASE_05',
  'EX_BASE_06',
  'EX_BASE_07',
  'EX_BASE_08',
] as const;

/**
 * Service descriptions, where one is on record: 01 and 02 from guide §2.1.9; 05, 07 and 08 from a
 * production catalogue of another employer captured 2026-08-12. 03 and 06: none
 * recorded — the guide calls a description optional.
 */
const SERVICE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  EX_BASE_01: 'ΣΤΟΙΧΕΙΑ ΕΡΓΟΔΟΤΗ',
  EX_BASE_02: 'ΣΤΟΙΧΕΙΑ ΠΑΡΑΡΤΗΜΑΤΩΝ',
  EX_BASE_05: 'ΣΤΟΙΧΕΙΑ ΕΡΓΑΖΟΜΕΝΩΝ',
  EX_BASE_07: 'ΣΤΟΙΧΕΙΑ ΗΜΕΡΟΛΟΓΙΟΥ ΠΡΑΓΜΑΤΙΚΗΣ ΑΠΑΣΧΟΛΗΣΗΣ',
  EX_BASE_08: 'ΣΤΟΙΧΕΙΑ ΤΡΕΧΟΥΣΑΣ ΚΑΤΑΣΤΑΣΗΣ ΨΗΦΙΑΚΗΣ ΟΡΓΑΝΩΣΗΣ ΧΡΟΝΟΥ ΕΡΓΑΣΙΑΣ',
};

/** The two read services this fake answers. */
export type ReadService = 'EX_BASE_07' | 'EX_BASE_08';

/**
 * ⚠⚠ UNMEASURED — the name of each service's Date parameter. A placeholder, not the ministry's.
 * A reader must learn the real name from `ServicesList` at run time (R1), never from here.
 */
export const UNMEASURED_DATE_PARAMETER: Readonly<Record<ReadService, string>> = {
  EX_BASE_07: 'UnmeasuredDate07',
  EX_BASE_08: 'UnmeasuredDate08',
};

/**
 * ⚠⚠ UNMEASURED — the key under the service code that holds the rows. A placeholder, not the
 * ministry's. The documented PATTERN is real (`{"EX_BASE_01": {"Ergodotis": {…}}}`, §2.1.10); the
 * name inside it is not known for 07 or 08.
 */
export const UNMEASURED_ROWS_KEY: Readonly<Record<ReadService, string>> = {
  EX_BASE_07: 'UnmeasuredRows07',
  EX_BASE_08: 'UnmeasuredRows08',
};

/** The branch parameter — declared `Int` by ServicesList (measured), carried like every value as a string. */
export const BRANCH_PARAMETER = 'PararthmaAa';

/**
 * Verbatim from the machine-readable parameter docs of a production catalogue captured 2026-08-12
 * from another employer. Placed on the Date parameter, the one it restricts.
 */
const DATE_WINDOW_DESCRIPTION = 'Περιορισμός σε ημ/νιες προηγούμενου μήνα και πίσω';

/** Guide §2.1.10, verbatim — the answer to a service this employer is not entitled to. */
export const NOT_ENTITLED_MESSAGE = 'Service Code is not authenticated to specific User';

/**
 * ⛔⛔ MEASURED 24/09/2026 on both sides of the line: 24/09/2026 and 01/09/2026 answered HTTP 400 with
 * this; 31/08/2026 and 15/07/2026 answered 200. A date in the current Athens month or later is
 * refused — a fake that accepted today would let a reader ship a bug that only appears in production.
 */
export const OUT_OF_WINDOW_MESSAGE = "Criteria doesn't meet requirements";

/**
 * Guide §2.1.6 / §2.2.1, verbatim — with a literal backslash-n, two characters, exactly as the guide's
 * wire body carries it. ⓘ The guide's «0» is read as the Card's `f_aa`; its example branch is `"0"`.
 */
export function wrongEmployerMessage(aa: string): string {
  return `Για το Παράρτημα: ${aa}\\nΤο ΑΦΜ δεν αντιστοιχεί στον συνδεδεμένο εργοδότη.`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The rows it serves
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** An `EX_BASE_07` row. Field names measured 2026-09-24; ⚠ value formats UNMEASURED — see the file docblock. */
export interface FakeStampRow {
  Afm: string;
  Date: string;
  HourFrom: string;
  HourTo: string;
  /** The night-shift flag: the exit falls on the day after `Date`. `"0"`/`"1"` like EX_BASE_01's `IsInCardSector`. */
  IsEndDateDifferentThanDate: string;
}

/**
 * An `EX_BASE_08` row — ⭐ in the shape MEASURED 2026-09-28 (src/ergani/types.ts `ScheduleRow`): `aa`, `Date`,
 * hours as `HH:MM:SS` on a working row, NO hour fields on a leave or rest row, `Extra: null` on working
 * and rest rows and absent on leave rows.
 */
export interface FakeScheduleRow {
  aa: string;
  Afm: string;
  Date: string;
  Type: string;
  HourFrom?: string;
  HourTo?: string;
  BreakMinutes: string;
  BreakInWork: string;
  Extra?: string | null;
}

/** Rows keyed by the date asked for, `DD/MM/YYYY`. Any in-window date not listed answers zero rows. */
export type RowsByDate<Row> = Readonly<Record<string, readonly Row[]>>;

/**
 * Stamps for two August 2026 days — the month before the measured "today". One ordinary day, and one
 * with the night-shift flag set, because a reader that drops it files the exit against the wrong day.
 * ⓘ One row per person per day: how ΕΡΓΑΝΗ stores a σπαστό ωράριο is measurement M1, and this fake
 * does not pretend to know.
 */
export const SAMPLE_STAMPS: RowsByDate<FakeStampRow> = {
  '28/08/2026': [
    { Afm: '000000000', Date: '28/08/2026', HourFrom: '17:00', HourTo: '00:30', IsEndDateDifferentThanDate: '1' },
  ],
  '31/08/2026': [
    { Afm: '000000000', Date: '31/08/2026', HourFrom: '08:00', HourTo: '16:00', IsEndDateDifferentThanDate: '0' },
  ],
};

const workDay = (afm: string, date: string): FakeScheduleRow => ({
  aa: '0',
  Afm: afm,
  Date: date,
  Type: 'ΕΡΓ',
  HourFrom: '08:00:00',
  HourTo: '16:00:00',
  Extra: null,
  // Measured: a 15′ break, outside working hours.
  BreakMinutes: '15',
  BreakInWork: '0',
});

/**
 * ⚠ A leave day with NO working interval — `ΑΔΠΠΜ`, «Ειδική παροχή προστασίας της μητρότητας» (the
 * guide's §4 example code). Measured: a leave row has no hour fields and no `Extra`, and it stands
 * BESIDE the employee's ordinary «ΕΡΓ» row for the day. A row with no hours is a NORMAL case, and a
 * reader that treats it as an error fails on the first day someone is on leave.
 */
const leaveDay = (afm: string, date: string): FakeScheduleRow => ({
  aa: '0',
  Afm: afm,
  Date: date,
  Type: 'ΑΔΠΠΜ',
  BreakMinutes: '15',
  BreakInWork: '0',
});

const scheduleOn = (date: string) => [workDay('000000000', date), workDay('999999999', date), leaveDay('999999999', date)];

export const SAMPLE_SCHEDULE: RowsByDate<FakeScheduleRow> = {
  '28/08/2026': scheduleOn('28/08/2026'),
  '31/08/2026': scheduleOn('31/08/2026'),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Card_v1.xsd — read, not transcribed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type XsdBase = 'xs:string' | 'xs:date' | 'xs:dateTime';

interface SimpleRule {
  base: XsdBase;
  pattern?: { source: string; regex: RegExp };
  length?: number;
  maxLength?: number;
  enumeration?: string[];
}

interface ElementDecl {
  name: string;
  minOccurs: number;
  maxOccurs: number;
  /** A complex type by name, or… */
  type?: string;
  /** …an inline simple type. Exactly one of the two. */
  simple?: SimpleRule;
}

interface CardXsd {
  root: ElementDecl;
  complexTypes: ReadonlyMap<string, readonly ElementDecl[]>;
}

/**
 * Parse exactly the XSD subset `Card_v1.xsd` uses, and THROW on anything else — an unrecognised facet,
 * attribute, base type or nesting fails the suite loudly instead of being skipped. A validator that
 * quietly ignored a rule it did not understand would accept what the ministry refuses.
 */
function parseCardXsd(xsd: string): CardXsd {
  const text = xsd.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '');
  const complexTypes = new Map<string, ElementDecl[]>();
  for (const m of text.matchAll(/<xs:complexType name="(\w+)">([\s\S]*?)<\/xs:complexType>/g)) {
    complexTypes.set(m[1] ?? '', elementsIn(m[2] ?? ''));
  }
  const roots = elementsIn(text.replace(/<xs:complexType[\s\S]*?<\/xs:complexType>/g, ''));
  const [root] = roots;
  if (root === undefined || roots.length !== 1) throw new Error('Card_v1.xsd: expected one root element');
  for (const decl of [root, ...[...complexTypes.values()].flat()]) {
    if (decl.type !== undefined && !complexTypes.has(decl.type)) {
      throw new Error(`Card_v1.xsd: ${decl.name} refers to unknown type ${decl.type}`);
    }
  }
  return { root, complexTypes };
}

function elementsIn(block: string): ElementDecl[] {
  const out: ElementDecl[] = [];
  for (const m of block.matchAll(/<xs:element\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xs:element>)/g)) {
    const inner = m[2] ?? '';
    if (inner.includes('<xs:element')) throw new Error('Card_v1.xsd: nested element declarations are not supported');
    const attrs = new Map([...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? '']));
    for (const key of attrs.keys()) {
      if (!['name', 'type', 'nillable', 'minOccurs', 'maxOccurs'].includes(key)) {
        throw new Error(`Card_v1.xsd: unsupported attribute ${key}`);
      }
    }
    const name = attrs.get('name');
    if (name === undefined) throw new Error('Card_v1.xsd: an element without a name');
    const max = attrs.get('maxOccurs') ?? '1';
    const decl: ElementDecl = {
      name,
      minOccurs: Number(attrs.get('minOccurs') ?? '1'),
      maxOccurs: max === 'unbounded' ? Infinity : Number(max),
    };
    const type = attrs.get('type');
    if (type !== undefined) decl.type = type;
    else decl.simple = simpleRuleOf(name, inner);
    out.push(decl);
  }
  return out;
}

function simpleRuleOf(name: string, inner: string): SimpleRule {
  const restriction = /<xs:restriction base="(xs:\w+)">([\s\S]*?)<\/xs:restriction>/.exec(inner);
  if (restriction === null) throw new Error(`Card_v1.xsd: ${name} has neither a type nor a restriction`);
  const base = restriction[1];
  if (base !== 'xs:string' && base !== 'xs:date' && base !== 'xs:dateTime') {
    throw new Error(`Card_v1.xsd: ${name} has unsupported base ${base}`);
  }
  const rule: SimpleRule = { base };
  const body = restriction[2] ?? '';
  for (const f of body.matchAll(/<xs:(\w+)\s+value="([^"]*)"\s*\/>/g)) {
    const [facet, value] = [f[1] ?? '', f[2] ?? ''];
    if (facet === 'pattern') {
      // XSD patterns are implicitly anchored and share only a subset of syntax with JavaScript's.
      // Refuse anything outside the plain subset rather than translate it wrongly.
      if (rule.pattern !== undefined || /[\\^$&]/.test(value)) {
        throw new Error(`Card_v1.xsd: ${name} has a pattern this reader does not support`);
      }
      rule.pattern = { source: value, regex: new RegExp(`^(?:${value})$`, 'u') };
    } else if (facet === 'length') rule.length = Number(value);
    else if (facet === 'maxLength') rule.maxLength = Number(value);
    else if (facet === 'enumeration') rule.enumeration = [...(rule.enumeration ?? []), value];
    else throw new Error(`Card_v1.xsd: ${name} has unsupported facet ${facet}`);
  }
  if (body.replace(/<xs:(\w+)\s+value="([^"]*)"\s*\/>/g, '').trim() !== '') {
    throw new Error(`Card_v1.xsd: ${name} has restriction content this reader does not understand`);
  }
  return rule;
}

const CARD_XSD = parseCardXsd(
  readFileSync(new URL('../fixtures/ministry/Card_v1.xsd', import.meta.url), 'utf8'),
);

/**
 * Every way `payload` breaks `Card_v1.xsd`'s rules, as `path: rule` lines — empty when it conforms.
 * ⓘ Messages name the path and the rule, never the value: a value here is a person's name or ΑΦΜ.
 */
export function validateCardPayload(payload: unknown): string[] {
  const errors: string[] = [];
  checkObject(payload, [CARD_XSD.root], '', errors);
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkObject(value: unknown, decls: readonly ElementDecl[], path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path || '(body)'}: expected an object`);
    return;
  }
  const declared = new Set(decls.map((d) => d.name));
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) errors.push(`${join(path, key)}: not an element of Card_v1.xsd`);
  }
  for (const decl of decls) checkOccurrences(value[decl.name], decl, join(path, decl.name), errors);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function checkOccurrences(value: unknown, decl: ElementDecl, path: string, errors: string[]): void {
  if (value === undefined) {
    if (decl.minOccurs > 0) errors.push(`${path}: required`);
    return;
  }
  if (decl.maxOccurs <= 1) {
    checkOne(value, decl, path, errors);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array (maxOccurs ${decl.maxOccurs})`);
    return;
  }
  if (value.length < decl.minOccurs) errors.push(`${path}: at least ${decl.minOccurs} required`);
  if (value.length > decl.maxOccurs) errors.push(`${path}: at most ${decl.maxOccurs} allowed`);
  value.forEach((item, i) => checkOne(item, decl, `${path}[${i}]`, errors));
}

function checkOne(value: unknown, decl: ElementDecl, path: string, errors: string[]): void {
  if (decl.type !== undefined) {
    checkObject(value, CARD_XSD.complexTypes.get(decl.type) ?? [], path, errors);
    return;
  }
  if (value !== null && typeof value !== 'string') {
    errors.push(`${path}: expected a string`);
    return;
  }
  // `null` is an empty value — guide §2.1.6's own request sends `"f_aitiologia": null`.
  const problem = simpleProblem(value ?? '', decl.simple as SimpleRule);
  if (problem !== undefined) errors.push(`${path}: ${problem}`);
}

function simpleProblem(text: string, rule: SimpleRule): string | undefined {
  if (rule.base === 'xs:date' && !isXsdDate(text)) return 'not an xs:date';
  if (rule.base === 'xs:dateTime' && !isXsdDateTime(text)) return 'not an xs:dateTime';
  const length = [...text].length;
  if (rule.length !== undefined && length !== rule.length) return `length must be ${rule.length}`;
  if (rule.maxLength !== undefined && length > rule.maxLength) return `longer than ${rule.maxLength}`;
  if (rule.pattern !== undefined && !rule.pattern.regex.test(text)) return `does not match ${rule.pattern.source}`;
  if (rule.enumeration !== undefined && !rule.enumeration.includes(text)) {
    return `not one of ${rule.enumeration.join(', ')}`;
  }
  return undefined;
}

function isCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d <= days;
}

const TZ = '(?:Z|[+-](?:0\\d|1[0-4]):[0-5]\\d)?';

function isXsdDate(text: string): boolean {
  const m = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})${TZ}$`).exec(text);
  return m !== null && isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isXsdDateTime(text: string): boolean {
  const m = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?${TZ}$`).exec(text);
  if (m === null || !isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  const [h, min, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  return h < 24 && min < 60 && s < 60;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Time, in Athens
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ATHENS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Athens',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

/**
 * The Athens wall-clock reading of an instant. ⚠ "This month" is the ATHENS calendar month: at 00:30
 * Athens on the 1st it is still the previous day in UTC.
 */
function athens(ms: number) {
  const p = Object.fromEntries(ATHENS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const offset = (p['timeZoneName'] ?? 'GMT').replace('GMT', '') || '+00:00';
  return {
    year: p['year'] ?? '',
    month: p['month'] ?? '',
    day: p['day'] ?? '',
    hour: p['hour'] ?? '',
    minute: p['minute'] ?? '',
    second: p['second'] ?? '',
    offset,
  };
}

/** `refreshTokenExpired` in the guide's own form: local time, an offset, seven fractional digits. */
function isoWithOffset(ms: number): string {
  const a = athens(ms);
  const fraction = `${String(ms % 1000).padStart(3, '0')}0000`;
  return `${a.year}-${a.month}-${a.day}T${a.hour}:${a.minute}:${a.second}.${fraction}${a.offset}`;
}

/** `submitDate` in the guide's form: `DD/MM/YYYY HH:mm`. */
function submitDateOf(ms: number): string {
  const a = athens(ms);
  return `${a.day}/${a.month}/${a.year} ${a.hour}:${a.minute}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The server
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ErganiFakeOptions {
  /** Epoch ms. Drives token expiry, receipts and the read window. Default `MEASURED_NOW`, never the wall clock. */
  now?: () => number;
  /** The employer the credential authenticates as. Default `FAKE_EMPLOYER_AFM`. */
  employerAfm?: string;
  entitlement?: readonly string[];
  stamps?: RowsByDate<FakeStampRow>;
  schedule?: RowsByDate<FakeScheduleRow>;
  /** Move the UNMEASURED placeholders, to prove a reader learns them rather than hard-codes them. */
  dateParameter?: Readonly<Record<ReadService, string>>;
  rowsKey?: Readonly<Record<ReadService, string>>;
  /**
   * How the §2.1.8 PDF route answers. ⭐ `object` (the default) is the MEASURED shape (production, 2026-10-21):
   * `{"message": {…}, "document": "<Base64>", "documentName": "<name>"}`. `json-string` (`"JVBERi0…"`) and `bare` (the
   * Base64 text alone) are the two shapes guessed before it was measured, kept to prove the reader still takes them.
   */
  pdfShape?: 'object' | 'json-string' | 'bare';
  /**
   * The restricted login of each branch (`f_aa` → username and password). Default: branch `"0"` with
   * `FAKE_CREDENTIAL`. A session may file and read for ITS branch only (see the file docblock).
   */
  branchLogins?: Readonly<Record<string, { username: string; password: string }>>;
  /** The schedule per branch (`PararthmaAa` → rows by date), instead of `schedule` for every branch. */
  scheduleByBranch?: Readonly<Record<string, RowsByDate<FakeScheduleRow>>>;
  /**
   * Branches (`PararthmaAa`) on which no schedule was ever declared: their EX_BASE_08 answers a bare `null`, as
   * measured on a real account (2026-09-29, 2026-10-07; src/ergani/exbase.ts `NULL_MEANS_NO_ROWS`).
   */
  noScheduleDeclared?: readonly string[];
}

/** One request as the fake received it. `route` is the path under `FAKE_API_PATH`, without a query. */
export interface FakeRequest {
  method: string;
  route: string;
  body: string;
  authorization: string | undefined;
}

export interface ErganiFake {
  /** Point a client here: `http://127.0.0.1:<port>/WebservicesAPI/api`. */
  readonly baseUrl: string;
  readonly employerAfm: string;
  /** Every request received, in order — including the ones answered 401 or 429. */
  readonly requests: readonly FakeRequest[];
  /**
   * Answer the next `count` requests, whatever the route, with **429 Too Many Requests** — documented
   * («το σύνολο των κλήσεων … επιστρέφεται 429», Παράρτημα ΙΙ §3), but its threshold is not, so a test
   * says when. ⚠ The real 429 body was never observed; the fake sends none.
   */
  throttleNext(count: number): void;
  /**
   * Answer the next `count` FILINGS (`POST Documents/WRKCardSE`) with `status` and `body` instead of filing — a 400
   * with a ministry-shaped `{message}` for a refusal, a 500/503 for an outage. Other routes are unaffected.
   */
  failNextFilings(count: number, status: number, body?: unknown): void;
  /** Hold every filing's answer this long (real ms) — for the per-request timeout. 0 = answer at once. */
  delayFilings(ms: number): void;
  /** The cards the fake accepted, in order: each detail with the receipt it got. */
  readonly filed: ReadonlyArray<{ detail: Record<string, string>; protocol: string; submitDate: string }>;
  close(): Promise<void>;
}

interface Session {
  /** The branch whose login signed in. */
  branch: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  refreshSpent: boolean;
}

interface Reply {
  status: number;
  body?: unknown;
  /** A body sent as-is, not as JSON. */
  raw?: string | undefined;
  headers?: Record<string, string>;
}

const fakeSays = (what: string) => ({ message: `ergani-fake: ${what}` });

export async function startErganiFake(options: ErganiFakeOptions = {}): Promise<ErganiFake> {
  const now = options.now ?? (() => MEASURED_NOW);
  const employerAfm = options.employerAfm ?? FAKE_EMPLOYER_AFM;
  const entitlement = new Set(options.entitlement ?? MEASURED_ENTITLEMENT);
  const stamps = options.stamps ?? SAMPLE_STAMPS;
  const schedule = options.schedule ?? SAMPLE_SCHEDULE;
  const dateParameter = options.dateParameter ?? UNMEASURED_DATE_PARAMETER;
  const rowsKey = options.rowsKey ?? UNMEASURED_ROWS_KEY;

  const requests: FakeRequest[] = [];
  const byAccess = new Map<string, Session>();
  const byRefresh = new Map<string, Session>();
  let issued = 0;
  let receipts = 0;
  let throttle = 0;
  let failFilings = 0;
  let failReply: Reply = { status: 500 };
  let filingDelayMs = 0;
  const filed: Array<{ detail: Record<string, string>; protocol: string; submitDate: string }> = [];
  const pdfShape = options.pdfShape ?? 'object';
  const branchLogins = options.branchLogins ?? { [FAKE_BRANCH]: FAKE_CREDENTIAL };

  /** The shape of both `Authentication` and `Authentication/Refresh` (§2.1.1–§2.1.2). */
  function issue(branch: string): Reply {
    issued += 1;
    const t = now();
    const session: Session = {
      branch,
      accessToken: `fake-access-${issued}`,
      refreshToken: `fake-refresh-${issued}`,
      accessExpiresAt: t + ACCESS_TOKEN_LIFETIME_S * 1000,
      refreshExpiresAt: t + REFRESH_TOKEN_LIFETIME_MS,
      refreshSpent: false,
    };
    byAccess.set(session.accessToken, session);
    byRefresh.set(session.refreshToken, session);
    return {
      status: 200,
      body: {
        accessToken: session.accessToken,
        accessTokenExpired: ACCESS_TOKEN_LIFETIME_S,
        refreshToken: session.refreshToken,
        refreshTokenExpired: isoWithOffset(session.refreshExpiresAt),
      },
    };
  }

  function authenticate(body: unknown): Reply {
    if (!isObject(body)) return { status: 400, body: fakeSays('expected {Username, Password, Usertype}') };
    const branch = Object.entries(branchLogins).find(
      ([, login]) => body['Username'] === login.username && body['Password'] === login.password,
    )?.[0];
    const ok = branch !== undefined && body['Usertype'] === FAKE_CREDENTIAL.usertype;
    // ⚠ The real answer to a wrong credential was never observed; 401 is the fake's choice.
    return ok ? issue(branch) : { status: 401, body: fakeSays('wrong credential') };
  }

  /**
   * Παράρτημα ΙΙ §2 step 2: the OLD access token travels «μαζί με το refresh token του» — its own pair.
   * Step 3: a refresh token past its seven days answers 401. A spent refresh token is refused too
   * (the fake rotates the pair — whether the ministry does is not documented).
   */
  function refresh(body: unknown): Reply {
    const session = isObject(body) ? byRefresh.get(String(body['RefreshToken'])) : undefined;
    if (
      session === undefined ||
      !isObject(body) ||
      body['AccessToken'] !== session.accessToken ||
      session.refreshSpent ||
      now() >= session.refreshExpiresAt
    ) {
      return { status: 401 };
    }
    session.refreshSpent = true;
    return issue(session.branch);
  }

  /** Bearer check. An expired token is Παράρτημα ΙΙ §2's 401 WITH §2.1.1's `api-token-expired: true`. */
  function authorized(authorization: string | undefined, then: (session: Session) => Reply): Reply {
    const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    const session = token === undefined ? undefined : byAccess.get(token);
    if (session === undefined) return { status: 401 };
    if (now() >= session.accessExpiresAt) return { status: 401, headers: { [TOKEN_EXPIRED_HEADER]: 'true' } };
    return then(session);
  }

  /**
   * `POST /Documents/WRKCardSE` (§2.1.6) — what the stamping outbox files against in tests. ⛔ Never a real filing:
   * this fake is the only thing any test files to.
   */
  function file(body: unknown, session: Session): Reply {
    const errors = validateCardPayload(body);
    if (errors.length > 0) return { status: 400, body: fakeSays(`Card_v1.xsd: ${errors.join('; ')}`) };
    const cards = (body as { Cards: { Card: Array<{ f_afm_ergodoti: string; f_aa: string }> } }).Cards.Card;
    // `f_afm_ergodoti` is «Για επαλήθευση» (§2.2.1): checked against the AUTHENTICATED employer.
    const stranger = cards.find((c) => c.f_afm_ergodoti !== employerAfm);
    if (stranger !== undefined) return { status: 400, body: { message: wrongEmployerMessage(stranger.f_aa) } };
    const elsewhere = options.branchLogins === undefined ? undefined : cards.find((c) => c.f_aa !== session.branch);
    if (elsewhere !== undefined) {
      return { status: 400, body: fakeSays(`branch ${session.branch}'s login filed a card for branch ${elsewhere.f_aa}`) };
    }
    // One receipt per Card — ⓘ inferred from the file name `WorkCard_2submissions.json`, not measured.
    return {
      status: 200,
      body: (cards as unknown as Array<{ Details: { CardDetails: Array<Record<string, string>> } }>).map((card) => {
        receipts += 1;
        const receipt = { id: String(receipts), protocol: `ΕΥΣ${receipts}`, submitDate: submitDateOf(now()) };
        for (const detail of card.Details.CardDetails) filed.push({ detail, protocol: receipt.protocol, submitDate: receipt.submitDate });
        return receipt;
      }),
    };
  }

  /**
   * `GET Documents/WRKCardSE?protocol=…&submittedDate=yyyymmdd` (§2.1.8): the proof PDF of a filing this fake
   * accepted, keyed on BOTH the protocol and the day — a wrong day is refused like an unknown protocol. The bytes are
   * a tiny PDF made up here (`%PDF-1.4`, marked ergani-fake), never a ministry document.
   */
  function pdf(query: string): Reply {
    const q = new URLSearchParams(query);
    const protocol = q.get('protocol') ?? '';
    const day = q.get('submittedDate') ?? '';
    const match = filed.find((f) => f.protocol === protocol);
    const [dd, mm, yyyy] = (match?.submitDate.slice(0, 10) ?? '').split('/');
    if (match === undefined || day !== `${yyyy}${mm}${dd}`) {
      return { status: 400, body: fakeSays('no submission with that protocol on that day') };
    }
    const bytes = Buffer.from(`%PDF-1.4\n% ergani-fake proof for ${protocol}\n%%EOF\n`, 'utf8').toString('base64');
    if (pdfShape === 'object') {
      return { status: 200, body: { message: { ergani_fake: 'measured shape' }, document: bytes, documentName: `${protocol}.pdf` } };
    }
    return { status: 200, body: pdfShape === 'json-string' ? bytes : undefined, raw: pdfShape === 'bare' ? bytes : undefined };
  }

  function catalogue(): Reply {
    return {
      status: 200,
      body: [...entitlement].map((name) => ({
        name,
        description: SERVICE_DESCRIPTIONS[name] ?? '',
        parameters: name === 'EX_BASE_07' || name === 'EX_BASE_08' ? declaredParameters(name) : [],
      })),
    };
  }

  /** §2.1.9's parameter shape. The guide shows `type` as a word (`"Int"`); the fake uses the word. */
  function declaredParameters(code: ReadService) {
    return [
      { name: dateParameter[code], description: DATE_WINDOW_DESCRIPTION, isRequired: true, type: 'Date', maxLength: 0 },
      { name: BRANCH_PARAMETER, description: '', isRequired: true, type: 'Int', maxLength: 0 },
    ];
  }

  /** `POST /WebServices/ExecuteService` (§2.1.10): `{ServiceCode, Parameters: [{ParameterName, ParameterValue}]}`. */
  function execute(body: unknown, session: Session): Reply {
    if (!isObject(body) || typeof body['ServiceCode'] !== 'string') {
      return { status: 400, body: fakeSays('ServiceCode is required') };
    }
    const code = body['ServiceCode'];
    if (!entitlement.has(code)) return { status: 400, body: { message: NOT_ENTITLED_MESSAGE } };
    if (code !== 'EX_BASE_07' && code !== 'EX_BASE_08') {
      return { status: 501, body: fakeSays(`${code} is entitled but this fake does not serve it`) };
    }

    const given = body['Parameters'];
    if (!Array.isArray(given)) return { status: 400, body: fakeSays('Parameters must be an array') };
    const params = new Map<string, string>();
    for (const p of given) {
      if (!isObject(p) || typeof p['ParameterName'] !== 'string' || typeof p['ParameterValue'] !== 'string') {
        return { status: 400, body: fakeSays('each parameter is {ParameterName, ParameterValue}, both strings') };
      }
      if (params.has(p['ParameterName'])) return { status: 400, body: fakeSays('a parameter is given twice') };
      params.set(p['ParameterName'], p['ParameterValue']);
    }
    // ⚠ Strict on purpose: a misnamed parameter must never read as a month in which nobody stamped.
    const expected = [dateParameter[code], BRANCH_PARAMETER];
    const unknown = [...params.keys()].filter((name) => !expected.includes(name));
    const missing = expected.filter((name) => !params.has(name));
    if (unknown.length > 0 || missing.length > 0) {
      return {
        status: 400,
        body: fakeSays(`${code} parameters — unknown: [${unknown.join(', ')}], missing: [${missing.join(', ')}]`),
      };
    }

    const date = params.get(dateParameter[code]) ?? '';
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    if (dm === null || !isCalendarDay(Number(dm[3]), Number(dm[2]), Number(dm[1]))) {
      return { status: 400, body: fakeSays('the date must be DD/MM/YYYY') };
    }
    if (!/^[0-9]+$/.test(params.get(BRANCH_PARAMETER) ?? '')) {
      return { status: 400, body: fakeSays(`${BRANCH_PARAMETER} is an Int`) };
    }
    const branch = String(Number(params.get(BRANCH_PARAMETER)));
    if (options.branchLogins !== undefined && branch !== session.branch) {
      return { status: 400, body: fakeSays(`branch ${session.branch}'s login read branch ${branch}`) };
    }
    const today = athens(now());
    const asked = Number(dm[3]) * 12 + Number(dm[2]);
    if (asked >= Number(today.year) * 12 + Number(today.month)) {
      return { status: 400, body: { message: OUT_OF_WINDOW_MESSAGE } };
    }

    const rows = (code === 'EX_BASE_07' ? stamps : (options.scheduleByBranch?.[branch] ?? schedule))[date] ?? [];
    // ⭐ MEASURED (2026-09-28): EX_BASE_07 answers a day with no stamps with HTTP 200 and a bare `null`.
    // (EX_BASE_08 has never been seen with no rows; the fake keeps the documented empty pattern for it.)
    if (code === 'EX_BASE_07' && rows.length === 0) return { status: 200, body: null };
    // ⭐ MEASURED: EX_BASE_08 answers a bare `null` for a branch on which no schedule was ever declared.
    if (code === 'EX_BASE_08' && options.noScheduleDeclared?.includes(branch) === true) return { status: 200, body: null };
    return { status: 200, body: { [code]: { [rowsKey[code]]: rows } } };
  }

  function route(method: string, path: string, query: string, raw: string, authorization: string | undefined): Reply {
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      return { status: 400, body: fakeSays('the body is not JSON') };
    }
    const key = `${method} ${path}`;
    if (query === '') {
      if (key === 'POST Authentication') return authenticate(body);
      if (key === 'POST Authentication/Refresh') return refresh(body);
      if (key === 'GET Lookup/Submissions') return authorized(authorization, () => ({ status: 200, body: SUBMISSIONS }));
      if (key === 'GET Documents/WRKCardSE') return authorized(authorization, () => ({ status: 200, body: WORK_CARD_SCHEMA }));
      if (key === 'POST Documents/WRKCardSE') {
        return authorized(authorization, (session) => {
          if (failFilings > 0) {
            failFilings -= 1;
            return failReply;
          }
          return file(body, session);
        });
      }
      if (key === 'GET WebServices/ServicesList') return authorized(authorization, catalogue);
      if (key === 'POST WebServices/ExecuteService') return authorized(authorization, (session) => execute(body, session));
    }
    if (key === 'GET Documents/WRKCardSE' && query !== '') return authorized(authorization, () => pdf(query));
    // A documented route the fake does not serve (Logout, other forms) is a 501
    // — never a made-up ministry answer.
    if (/^(Authentication\/Logout|Documents\/)/.test(path)) {
      return { status: 501, body: fakeSays(`${key}${query} is not served by this fake`) };
    }
    return { status: 404, body: fakeSays(`no such route: ${key}`) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const authorization = req.headers.authorization;

    let reply: Reply;
    if (!url.pathname.startsWith(`${FAKE_API_PATH}/`)) {
      reply = { status: 404, body: fakeSays(`outside ${FAKE_API_PATH}`) };
    } else {
      const path = url.pathname.slice(FAKE_API_PATH.length + 1);
      requests.push({ method, route: path, body: raw, authorization });
      if (throttle > 0) {
        throttle -= 1;
        reply = { status: 429 };
      } else {
        reply = route(method, path, url.search, raw, authorization);
      }
    }

    if (filingDelayMs > 0 && method === 'POST' && url.pathname.endsWith('/Documents/WRKCardSE')) {
      await new Promise((resolve) => setTimeout(resolve, filingDelayMs));
    }
    const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    res.writeHead(reply.status, {
      ...(payload === '' ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...reply.headers,
    });
    res.end(payload);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(`ergani-fake: ${String(err)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}${FAKE_API_PATH}`,
    employerAfm,
    requests,
    throttleNext(count: number) {
      throttle = count;
    },
    failNextFilings(count: number, status: number, body?: unknown) {
      failFilings = count;
      failReply = { status, body };
    },
    delayFilings(ms: number) {
      filingDelayMs = ms;
    },
    filed,
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/**
 * A client `Config` pointed at `fake`, authenticating with `FAKE_CREDENTIAL` as `fake.employerAfm`.
 * ⓘ Built directly rather than through `loadConfig`, on purpose: the ministry's example employer
 * `012345678` fails the mod-11 check `loadConfig` rightly applies to a real ΑΦΜ, and a checksum-valid
 * number would be one that could belong to a real person. The client itself never sends `employerAfm`.
 */
export function fakeClientConfig(fake: ErganiFake, overrides: Partial<Config> = {}): Config {
  // ⓘ A branch other than "0" signs in as that branch's login from `branchLogins` (see `branchLogin`).
  return {
    employerAfm: fake.employerAfm,
    branchCode: FAKE_BRANCH,
    erganiUsername: FAKE_CREDENTIAL.username,
    erganiPassword: new Secret(FAKE_CREDENTIAL.password),
    erganiUsertype: FAKE_CREDENTIAL.usertype,
    erganiRealm: 'local',
    erganiBaseUrl: fake.baseUrl,
    ...overrides,
  };
}

/** A branch's fabricated login, as `branchLogins` takes it: `fixture0<code>` / `Fixture.p<code>`. */
export function branchLogin(code: string): { username: string; password: string } {
  return code === FAKE_BRANCH ? FAKE_CREDENTIAL : { username: `fixture1${code.padStart(2, '0')}`, password: `Fixture.b${code}` };
}

/** A client `Config` for `branch`, signing in with `branchLogin(branch)`. */
export function fakeBranchConfig(fake: ErganiFake, branch: string): Config {
  const login = branchLogin(branch);
  return fakeClientConfig(fake, {
    branchCode: branch,
    erganiUsername: login.username,
    erganiPassword: new Secret(login.password),
  });
}
