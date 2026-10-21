// SPDX-License-Identifier: EUPL-1.2
import { z } from 'zod';

/**
 * The ΕΡΓΑΝΗ ΙΙ wire contract.
 *
 * ⭐ THE CARD SHAPES ARE THE MINISTRY'S OWN, not a transcription of prose. `Card`, `CardDetail` and
 * `WorkCardSubmission` follow **`Card_v1.xsd`** field for field — types, patterns, lengths and the
 * `f_type` enumeration — checked against the ministry's own `Card.json` and
 * `WorkCard_2submissions.json`. `SubmissionResult` is the documented success body of the
 * interoperability guide «Σύστημα Εκτέλεσης Υπηρεσιών Διαλειτουργικότητας», 18.02.2026, §2.1.6 and
 * §2.2.1. Three of the four are vendored, byte for byte, in `test/fixtures/ministry/` (PROVENANCE.md).
 * ⓘ `AuthResponse` and `SubmissionType` are not in the XSD; they follow the same guide.
 *
 * ⓘ Field names are the ministry's (`f_afm_ergodoti`, `f_aa`, …). They are not renamed to something
 * more readable, deliberately: when an HTTP 400 arrives as a free-text Greek sentence naming a
 * field, you want to be able to grep for that exact string.
 */

/** ΕΡΓΑΝΗ `Usertype`. ⚠ All three are EMPLOYER identities — there is no vendor or delegate type. */
export const Usertype = z.enum(['01', '02', '03']);
export type Usertype = z.infer<typeof Usertype>;

/**
 * The body of `POST /Authentication` AND of `POST /Authentication/Refresh` — the guide says of the
 * latter «όπως του Authentication» (§2.1.1–2.1.2). Two tokens with two different lifetimes, in two
 * different units: the access token's is SECONDS, the refresh token's is an ISO TIMESTAMP.
 * ⓘ Optional so that a response missing one degrades to a full re-authentication on expiry rather
 * than failing to sign in at all; the client depends only on `accessToken`.
 */
export const AuthResponse = z
  .object({
    accessToken: z.string(),
    /**
     * Seconds. `10800` — three hours — in the guide's example (§2.1.1) and in Παράρτημα ΙΙ §2, and
     * measured live (2026-09-24). ⚠ The ministry reserves the right to change it («δύναται να
     * αλλάξουν»); expiry is also signalled by the `api-token-expired: true` response header.
     */
    accessTokenExpired: z.number().optional(),
    /** Trades for a fresh pair at `Authentication/Refresh` without re-sending the credential. */
    refreshToken: z.string().optional(),
    /**
     * When the refresh token dies — an ISO timestamp with an offset and seven fractional digits,
     * `"2022-05-10T09:43:37.5388855+03:00"` in the guide (§2.1.1). Seven days from issue (Παράρτημα
     * ΙΙ §2). ⓘ Kept as the string received: it only spares a refresh the ministry would refuse,
     * and the ministry's 401 is the authority either way.
     */
    refreshTokenExpired: z.string().optional(),
  })
  // ⚠ PASSTHROUGH ON PURPOSE. A strict object would throw away fields the ministry adds without
  // notice, and — worse — a stripped response makes an undocumented change invisible until
  // something downstream misbehaves. We validate what we depend on and keep the rest.
  .passthrough();
export type AuthResponse = z.infer<typeof AuthResponse>;

/**
 * One entry of `GET /Lookup/Submissions` — the employer's ACTIVE submission types.
 *
 * ⚠ This list is per-employer, not a global catalogue.
 * ⛔⛔ Never key code on the numeric `id`. It is per-install and has already moved: the guide
 * records `WRKCardSE` as 82, and the live list of one employer returned **184**, among 41 active forms
 * (measured 2026-09-24). Look a form up by its `code` string — `WORK_CARD_CODE` below.
 */
export const SubmissionType = z
  .object({
    code: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type SubmissionType = z.infer<typeof SubmissionType>;

/** The work-card submission code. One endpoint, seven fields — the entire feature surface. */
export const WORK_CARD_CODE = 'WRKCardSE';

/**
 * Card event type — `Card_v1.xsd`: `xs:enumeration` of exactly `0` and `1`, documented «Τύπος
 * Κίνησης (0) ΕΙΣΟΔΟΣ (1) ΕΞΟΔΟΣ»; the guide §2.2.1 says the same, «0 Προσέλευση, 1 Αποχώρηση».
 * ⓘ Strings on the wire, quoted in every ministry example — not numbers.
 */
export const CardEventType = z.enum(['0', '1']);
export type CardEventType = z.infer<typeof CardEventType>;

/** ΕΝΑΡΞΗ / ΛΗΞΗ, named so call sites read as Greek labour law rather than as magic strings. */
export const ENARXI: CardEventType = '0';
export const LIXI: CardEventType = '1';

/**
 * An ΑΦΜ as `Card_v1.xsd` constrains it: exactly nine digits. ⓘ Only the shape the ministry
 * enforces — the mod-11 check digit is `isValidAfm` in config.ts, applied where a number is entered.
 */
const Afm = z.string().regex(/^[0-9]{9}$/, 'ΑΦΜ must be exactly 9 digits (Card_v1.xsd)');

/**
 * `f_aa`, «Α/Α ΠΑΡΑΡΤΗΜΑΤΟΣ» — the branch number. `Card_v1.xsd`: `xs:string`, pattern
 * `[0-9]{1,5}`, and every ministry example sends it quoted (`"0"`, `"1"`).
 * ⚠ A STRING, not a number: a numeric `0` serialises unquoted and the POST no longer matches the
 * schema the ministry validates against.
 */
export const BranchAa = z.string().regex(/^[0-9]{1,5}$/, 'f_aa must be 1–5 digits (Card_v1.xsd)');

/**
 * `WorkCardDelayReason` — the late-filing reason codes, read from the live ΕΡΓΑΝΗ codelist
 * (measured 2026-09-24). The XSD itself allows any 1–10 digits; these three are all the
 * codelist holds, so the type is closed and a fourth code is a compile error, not a guess.
 */
export const WorkCardDelayReason = z.enum(['001', '002', '003']);
export type WorkCardDelayReason = z.infer<typeof WorkCardDelayReason>;

/** The ministry's own label beside each code, as the codelist returns it. */
export const WORK_CARD_DELAY_REASON_LABELS: Record<WorkCardDelayReason, string> = {
  '001': 'ΗΛΕΚΤΡΟΔΟΤΗΣΗ/ΤΗΛΕΠΙΚΟΙΝΩΝΙΕΣ',
  '002': 'ΣΥΣΤΗΜΑΤΑ ΕΡΓΟΔΟΤΗ',
  '003': 'ΣΥΝΔΕΣΗ ΜΕ ΠΣ ΕΡΓΑΝΗ',
};

export const CardDetail = z.object({
  /** The EMPLOYEE's ΑΦΜ — which real person this declaration is about. */
  f_afm: Afm,
  /** ≤ 50 (`Card_v1.xsd`). ⚠ A longer Greek surname is a real HTTP 400 from a real register. */
  f_eponymo: z.string().max(50),
  /** ≤ 30 (`Card_v1.xsd`). */
  f_onoma: z.string().max(30),
  f_type: CardEventType,
  /**
   * The working DAY the event belongs to (`YYYY-MM-DD`).
   *
   * ⚠⚠ NOT the same as `f_date`, and the difference is load-bearing for a dental practice. A split
   * shift files four events against ONE reference date; the state merges them earliest-έναρξη /
   * latest-λήξη per interval. ⚠ Whether four events yield two intervals or collapse into one is
   * measurement M1 — the current manual (§4.3.3–4.3.4) and a surviving 2022 paragraph (p.176)
   * disagree, and the answer decides whether this model is correct at all.
   */
  f_reference_date: z.string(),
  /** The instant of the event itself. */
  f_date: z.string(),
  /**
   * The late-filing REASON CODE — `Card_v1.xsd`: «ΚΩΔΙΚΟΣ ΑΙΤΙΟΛΟΓΙΑΣ (Σε περίπτωση
   * Εκπρόθεσμου)», pattern `([0-9]{1,10})|([ ]*)`. A code from `WorkCardDelayReason`, never prose;
   * blank (the pattern's `([ ]*)` branch) for an on-time filing.
   *
   * ⚠⚠ Setting this does NOT discharge the employer's duty to notify the Επιθεώρηση Εργασίας
   * twice — «αμέσως μόλις προκύψει και μόλις λήξει», when the condition arises and when it ends.
   * The code only explains a late filing to ΕΡΓΑΝΗ; it tells no inspector anything. For this
   * employer the notification is an immediate email to its own Επιθεώρηση, even on a Sunday.
   * docs/RULES.md rule 5.
   */
  f_aitiologia: z.union([WorkCardDelayReason, z.literal('')]).default(''),
});
export type CardDetail = z.infer<typeof CardDetail>;

export const Card = z.object({
  /** ⚠ Validated by ΕΡΓΑΝΗ against the AUTHENTICATED employer — one POST can never span two. */
  f_afm_ergodoti: Afm,
  /**
   * Branch (παράρτημα). One POST CAN batch several branches of the same employer.
   * ⓘ This software sends one card per POST, with the card's own branch and that branch's login.
   */
  f_aa: BranchAa,
  /** ≤ 200 (`Card_v1.xsd`). */
  f_comments: z.string().max(200).default(''),
  Details: z.object({ CardDetails: z.array(CardDetail).min(1) }),
});
export type Card = z.infer<typeof Card>;

export const WorkCardSubmission = z.object({ Cards: z.object({ Card: z.array(Card).min(1) }) });
export type WorkCardSubmission = z.infer<typeof WorkCardSubmission>;

/**
 * One entry of a successful filing's response. Guide §2.1.6 / §2.2.1, verbatim:
 * `[{ "id": "92", "protocol": "ΕΥΣ92", "submitDate": "04/05/2022 01:13" }]` — «id : Κλειδί
 * αποθήκευσης της υποβολής · protocol : Αριθμός πρωτοκόλλου · submitDate : Ημερομηνία Υποβολής».
 *
 * The ΑΡΙΘΜΟΣ ΠΡΩΤΟΚΟΛΛΟΥ is the ONLY proof the filing happened — there is no per-submission
 * read-back to reconcile against later. docs/RULES.md rule 2.
 * ⚠ The response carries NO PDF. The proof PDF is a separate route keyed on the protocol number
 * (`fetchSubmissionPdf`, client.ts).
 * ⓘ `submitDate` is `DD/MM/YYYY HH:mm`, not ISO — kept as the string received.
 */
export const SubmissionReceipt = z
  .object({
    id: z.string(),
    protocol: z.string(),
    submitDate: z.string(),
  })
  // Passthrough for the same reason as `AuthResponse`: an undocumented field is evidence.
  .passthrough();
export type SubmissionReceipt = z.infer<typeof SubmissionReceipt>;

/** ⚠ HTTP 200 with an ARRAY, not an object — the guide's success body is a list of receipts. */
export const SubmissionResult = z.array(SubmissionReceipt);
export type SubmissionResult = z.infer<typeof SubmissionResult>;

/**
 * One row of **`EX_BASE_07` — ΗΜΕΡΟΛΟΓΙΟ ΠΡΑΓΜΑΤΙΚΗΣ ΑΠΑΣΧΟΛΗΣΗΣ**: what an employee actually stamped.
 *
 * ⓘ The field NAMES were recorded by a read-only production probe (2026-09-24). No real stamp row
 * has ever been seen — both sampled days held none — so the VALUE formats are unmeasured, and every
 * value but the flag is kept exactly as the string received rather than parsed on a guess.
 * ⓘ Strings, because every value in the guide's read-service examples is quoted (§2.1.10, EX_BASE_01
 * and EX_BASE_04), numbers and flags included.
 *
 * ⛔ STRICT, not passthrough — the opposite of `AuthResponse`, deliberately. How ΕΡΓΑΝΗ stores a
 * σπαστό ωράριο is measurement M1; a second interval could arrive as exactly such an unknown field, and
 * a five-year record that quietly dropped it would show one long shift. An unknown field is refused
 * (`UnrecognisedAnswerError` in exbase.ts), and a human reads the answer before the parser changes.
 *
 * ⓘ MEASURED 2026-09-28 (first read by the scoped user, August and July): still no stamp row — a day
 * with none is answered with a bare `null` (see exbase.ts). The one fact the schedule service taught:
 * `EX_BASE_08` rows carry the branch as `aa`, although ServicesList's own text says `Aa`. So a stamp
 * row may name its branch under either spelling, or not at all; `readStamps` holds any it names to
 * the branch asked for.
 */
export const StampRow = z
  .object({
    /** The branch, as measured on EX_BASE_08's rows (2026-09-28). */
    aa: z.string().regex(/^[0-9]+$/).optional(),
    /** The branch, as ServicesList's text spells it for EX_BASE_07 (`{Aa: ΑΑ Παραρτήματος, …}`). */
    Aa: z.string().regex(/^[0-9]+$/).optional(),
    /** The employee's ΑΦΜ. ⚠ A string of nine digits: as a number, a leading zero would vanish. */
    Afm,
    /** The reference date the stamps belong to — the working day, not the instant of the exit. */
    Date: z.string().min(1),
    HourFrom: z.string(),
    HourTo: z.string(),
    /**
     * ⚠ THE NIGHT-SHIFT FLAG. True when the exit fell on the calendar day AFTER `Date`: a shift that
     * ends at 00:30 still belongs to the previous reference date. Dropping it files that exit against
     * the wrong day. Read from `"0"`/`"1"`, the form of the one flag the guide shows (EX_BASE_01's
     * `IsInCardSector: "0"`); ⚠ unmeasured for this service, so any other value is refused, never
     * guessed at.
     */
    IsEndDateDifferentThanDate: z.enum(['0', '1']).transform((flag) => flag === '1'),
  })
  .strict();
export type StampRow = z.infer<typeof StampRow>;

/**
 * One row of **`EX_BASE_08` — ΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ ΨΟΧΕ**: the declared schedule and leave, per employee
 * per day. Strict for the same reason as `StampRow`.
 *
 * ⭐ MEASURED 2026-09-28 — the first real rows, read by the scoped user:
 *   · every row carries `aa` (the branch, lower case — ServicesList's text says `Aa`), `Afm`, `Date`
 *     (`DD/MM/YYYY`, always the day asked for), `Type`, `BreakMinutes` and `BreakInWork`;
 *   · a working row (`Type` «ΕΡΓ») adds `HourFrom`/`HourTo` as `HH:MM:SS` and `Extra: null`;
 *   · a rest-day row («ΑΝ») has NO hour fields at all and `Extra: null`;
 *   · a leave row has NO hour fields and NO `Extra` — and it stands BESIDE the same employee's
 *     ordinary «ΕΡΓ» rows for the day, which ΕΡΓΑΝΗ keeps answering (see the comparison, model.ts).
 *   · an employee may hold two «ΕΡΓ» rows in a day — a σπαστό ωράριο is two rows, not a wider one.
 *
 * ⚠ A ROW WITH NO WORKING INTERVAL IS NORMAL. Missing hours, and a missing or null `Extra`, are read as
 * `''` — the record's columns are NOT NULL and part of its UNIQUE key, where a NULL would never match
 * itself and every re-read would store the row again. `''` is what the record already meant by «none».
 * Both hours or neither: one without the other is refused.
 */
export const ScheduleRow = z
  .object({
    aa: z.string().regex(/^[0-9]+$/),
    Afm,
    Date: z.string().min(1),
    Type: z.string().min(1),
    HourFrom: z.string().optional(),
    HourTo: z.string().optional(),
    BreakMinutes: z.string(),
    BreakInWork: z.string(),
    Extra: z.string().nullable().optional(),
  })
  .strict()
  .refine((row) => (row.HourFrom === undefined) === (row.HourTo === undefined), {
    message: 'HourFrom and HourTo come together or not at all',
  })
  .transform(({ HourFrom, HourTo, Extra, ...row }) => ({
    ...row,
    HourFrom: HourFrom ?? '',
    HourTo: HourTo ?? '',
    Extra: Extra ?? '',
  }));
export type ScheduleRow = z.infer<typeof ScheduleRow>;
