// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { ErganiError, type ErganiClient } from '../ergani/client.js';
import {
  ENARXI,
  SubmissionResult,
  WorkCardSubmission,
  type WorkCardDelayReason,
} from '../ergani/types.js';
import { rowToPunch, type Punch } from './capture.js';
import { DeadlineReachedError, withDeadline } from './deadline.js';
import type { StampStore } from './store.js';

/**
 * THE OUTBOX — files every card to ΕΡΓΑΝΗ, inside the 15 minutes, and hands to a human what it cannot.
 *
 * ── ⭐ RETRY IS SAFE (docs/RULES.md rule 3) ─────────────────────────────────────────────────────────────
 * Card events are idempotent-by-latest — «θεωρείται ως έγκυρο το περιεχόμενο της πιο πρόσφατης δήλωσης» — and there is
 * no cancel path. A lost answer is simply asked again; it cannot mint a second legal document. So there is no
 * rejected-vs-unknown machinery here, deliberately.
 *
 * ── ⚠⚠ THE WALL IS A HARD STOP (docs/RULES.md rule 4) ──────────────────────────────────────────────────
 * A card must reach ΕΡΓΑΝΗ within 15 minutes of its time (ΥΑ 49758/2022); after that it is «Εκπρόθεσμη» and a HUMAN
 * must choose one of the ministry's three reasons (manual p.174: it cannot be auto-filed). So: first attempt at once,
 * then +10 s, +30 s, +60 s and every 60 s — and no request leaves later than `LAST_SEND_MS` (14 minutes; one minute of
 * margin for the two clocks), enforced at the wire (`deadline.ts`). At the wall the card goes to the human queue.
 * An outbox that kept retrying past it would be a defect, not resilience.
 *
 * ── RULE 3's ONE BOUND, until M1 settles split shifts ──────────────────────────────────────────────
 * An ΕΝΑΡΞΗ is never sent after a later card of the same person and working day has been filed — AT ANY BRANCH of the
 * employer (the store holds them all). It goes to the queue, where the only choice is «covered» (the accountant
 * corrects it) — not even a human files it.
 *
 * ── ONE OUTBOX PER EMPLOYER, ONE CARD AT A TIME ──────────────────────────────────────────────────────
 * Each card is filed with the login of the branch it was stamped at (a Χρήστης Παραρτήματος acts for its own branch).
 * Cards go one after another, across all branches, in one loop: so rule 3's look and a send of another branch's card
 * can never run at the same time.
 *
 * ── RULE 8: NO CLASSIFIER OVER MINISTRY PROSE ──────────────────────────────────────────────────────
 * HTTP 400 is recorded as `refused` with ΕΡΓΑΝΗ's sentence verbatim and shown to a human at once; the outbox keeps
 * asking inside the window anyway (safe, and a 400 that was transient then files). Nothing reads the sentence.
 */

/** The statutory window. */
export const WALL_MS = 15 * 60_000;
/**
 * The last moment a request may leave for a card: the wall less a minute for the two clocks.
 * ⓘ DELIBERATE: the human queue opens HERE, not at the statutory 15. From this moment
 * nothing more is sent by itself, and whether ΕΡΓΑΝΗ counts the card late is decided by ITS clock, not ours — so the
 * card goes to a person at once rather than sitting a minute in limbo. A reason chosen in that minute is the person's
 * decision, recorded as such.
 */
export const LAST_SEND_MS = 14 * 60_000;
/**
 * When a card still not filed raises the alarm (desk + phone): the owner hears a card is not through. ⓘ It does NOT tell
 * anyone to stamp again on CardScanner (docs/DECISIONS.md, «One arrival, one card»).
 */
export const OVERDUE_MS = 5 * 60_000;
/** Gaps after the 1st, 2nd and 3rd failed attempt; every later gap is the last one. */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000];
/**
 * A human's «file late» decision is carried out for this long (retried every minute) — then it returns to the queue.
 * ⓘ Not a retry into compliance: the card is already late, a person chose the reason, and the page shows each try.
 */
export const LATE_WINDOW_MS = 2 * 60 * 60_000;
export const LATE_RETRY_MS = 60_000;
/** When to ask for the proof PDF after filing (gaps after each try); after the last, once a day (`EVIDENCE_DAILY_MS`). */
export const EVIDENCE_DELAYS_MS: readonly number[] = [
  5_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000, 6 * 3_600_000,
];
/**
 * A proof still missing after the scheduled tries is asked for once a day — never abandoned while ΕΡΓΑΝΗ may still hold
 * it (it keeps card data six months) — and listed for the owner (`cardsMissingProof`; the owner's `queue`).
 */
export const EVIDENCE_DAILY_MS = 24 * 3_600_000;
export const EVIDENCE_GIVE_UP_MS = 183 * 24 * 3_600_000;

export interface Attempt {
  id: number;
  punchId: number;
  decisionId: number | undefined;
  startedMs: number;
  finishedMs: number;
  fAitiologia: '' | WorkCardDelayReason;
  outcome: 'filed' | 'refused' | 'failed';
  httpStatus: number | undefined;
  message: string | undefined;
  protocol: string | undefined;
  submitDate: string | undefined;
}

export interface Decision {
  id: number;
  punchId: number;
  kind: 'file_late' | 'covered';
  fAitiologia: WorkCardDelayReason | undefined;
  byLabel: string;
  atMs: number;
}

/** What went wrong last, for a human: the outcome, the status, and ΕΡΓΑΝΗ's sentence verbatim when there was one. */
export interface Problem {
  outcome: 'refused' | 'failed';
  httpStatus: number | undefined;
  message: string;
  atMs: number;
}

export type CardState =
  | { kind: 'filed'; protocol: string; submitDate: string; filedMs: number; late: boolean }
  | { kind: 'covered'; byLabel: string; atMs: number }
  | {
      kind: 'sending';
      nextAttemptMs: number;
      attempts: number;
      /** Past `OVERDUE_MS`: the alarm is up. */
      overdue: boolean;
      /** The last moment a request may leave (`event + LAST_SEND_MS`). */
      untilMs: number;
      lastProblem: Problem | undefined;
    }
  | {
      kind: 'sending-late';
      decision: Decision;
      nextAttemptMs: number;
      attempts: number;
      untilMs: number;
      lastProblem: Problem | undefined;
    }
  | {
      kind: 'needs-human';
      /** `wall`: not filed in time · `blocked`: rule 3's bound · `late-failed`: a late filing did not go through. */
      why: 'wall' | 'blocked' | 'late-failed';
      /** Whether «file late with a reason» is offered (never for `blocked`). */
      canFileLate: boolean;
      lastProblem: Problem | undefined;
    };

function rowToAttempt(r: Record<string, unknown>): Attempt {
  const opt = (k: string) => (r[k] === null || r[k] === undefined ? undefined : String(r[k]));
  return {
    id: Number(r['id']),
    punchId: Number(r['punch_id']),
    decisionId: r['decision_id'] === null ? undefined : Number(r['decision_id']),
    startedMs: Number(r['started_ms']),
    finishedMs: Number(r['finished_ms']),
    fAitiologia: String(r['f_aitiologia']) as Attempt['fAitiologia'],
    outcome: String(r['outcome']) as Attempt['outcome'],
    httpStatus: r['http_status'] === null ? undefined : Number(r['http_status']),
    message: opt('message'),
    protocol: opt('protocol'),
    submitDate: opt('submit_date'),
  };
}

function rowToDecision(r: Record<string, unknown>): Decision {
  return {
    id: Number(r['id']),
    punchId: Number(r['punch_id']),
    kind: String(r['kind']) as Decision['kind'],
    fAitiologia: r['f_aitiologia'] === null ? undefined : (String(r['f_aitiologia']) as WorkCardDelayReason),
    byLabel: String(r['by_label']),
    atMs: Number(r['at_ms']),
  };
}

export function attemptsOf(db: StampStore, punchId: number): Attempt[] {
  return db.prepare('SELECT * FROM attempts WHERE punch_id = ? ORDER BY finished_ms, id').all(punchId).map(rowToAttempt);
}

export function decisionsOf(db: StampStore, punchId: number): Decision[] {
  return db.prepare('SELECT * FROM decisions WHERE punch_id = ? ORDER BY at_ms, id').all(punchId).map(rowToDecision);
}

/**
 * MAY a LATER card of the same person and working day have been filed? (Rule 3's bound.)
 * ⚠ «May», not «was». A later card counts once any send of it was STARTED and not answered with a 400 — ΕΡΓΑΝΗ
 * saying no is the only proof it did not get there. That takes in a filing whose answer was lost (a timeout after
 * ΕΡΓΑΝΗ took it, a 200 we could not read) and a send the service died in the middle of (a `dispatches` row with no
 * ending: every send is written down BEFORE it leaves). Counting receipts alone would send the ΕΝΑΡΞΗ after a ΛΗΞΗ
 * ΕΡΓΑΝΗ already holds, which is exactly what the bound forbids. The cost, stated once: in an outage that outlasts an
 * unfiled ΕΝΑΡΞΗ, a later card's failed try holds the ΕΝΑΡΞΗ for a human («covered» only) even if nothing reached ΕΡΓΑΝΗ.
 */
export function laterCardFiled(db: StampStore, punch: Punch): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM punches q
       WHERE q.employee_id = ? AND q.reference_date = ? AND (q.event_ms > ? OR (q.event_ms = ? AND q.id > ?))
         AND (EXISTS (SELECT 1 FROM attempts a WHERE a.punch_id = q.id AND a.outcome <> 'refused')
              OR (SELECT count(*) FROM dispatches d WHERE d.punch_id = q.id)
                 > (SELECT count(*) FROM attempts a WHERE a.punch_id = q.id AND a.outcome = 'refused'))
       LIMIT 1`,
    )
    .get(punch.employeeId, punch.referenceDate, punch.eventMs, punch.eventMs, punch.id);
  return row !== undefined;
}

function problemOf(attempt: Attempt | undefined): Problem | undefined {
  if (attempt === undefined || attempt.outcome === 'filed') return undefined;
  return {
    outcome: attempt.outcome,
    httpStatus: attempt.httpStatus,
    message: attempt.message ?? '',
    atMs: attempt.finishedMs,
  };
}

/**
 * The state of one card, derived from its rows — never stored, so it cannot disagree with them.
 * ⓘ Pure: `laterFiled` is passed in (`laterCardFiled`), so the rules can be tested without a database.
 */
export function cardState(
  punch: Punch,
  attempts: readonly Attempt[],
  decisions: readonly Decision[],
  laterFiled: boolean,
  nowMs: number,
): CardState {
  const filed = attempts.find((a) => a.outcome === 'filed');
  if (filed !== undefined) {
    return {
      kind: 'filed',
      protocol: filed.protocol ?? '',
      submitDate: filed.submitDate ?? '',
      filedMs: filed.finishedMs,
      late: filed.decisionId !== undefined,
    };
  }
  const covered = decisions.find((d) => d.kind === 'covered');
  if (covered !== undefined) return { kind: 'covered', byLabel: covered.byLabel, atMs: covered.atMs };

  const lastProblem = problemOf(attempts.at(-1));
  const blocked = punch.fType === ENARXI && laterFiled;
  if (blocked) return { kind: 'needs-human', why: 'blocked', canFileLate: false, lastProblem };

  const late = [...decisions].reverse().find((d) => d.kind === 'file_late');
  if (late !== undefined) {
    const tries = attempts.filter((a) => a.decisionId === late.id);
    const untilMs = late.atMs + LATE_WINDOW_MS;
    if (nowMs < untilMs) {
      const last = tries.at(-1);
      return {
        kind: 'sending-late',
        decision: late,
        nextAttemptMs: last === undefined ? late.atMs : last.finishedMs + LATE_RETRY_MS,
        attempts: tries.length,
        untilMs,
        lastProblem: problemOf(last),
      };
    }
    return { kind: 'needs-human', why: 'late-failed', canFileLate: true, lastProblem };
  }

  const auto = attempts.filter((a) => a.decisionId === undefined);
  const untilMs = punch.eventMs + LAST_SEND_MS;
  if (nowMs < untilMs) {
    const last = auto.at(-1);
    const gap = RETRY_DELAYS_MS[Math.min(auto.length - 1, RETRY_DELAYS_MS.length - 1)] ?? 0;
    return {
      kind: 'sending',
      nextAttemptMs: last === undefined ? punch.eventMs : last.finishedMs + gap,
      attempts: auto.length,
      overdue: nowMs >= punch.eventMs + OVERDUE_MS,
      untilMs,
      lastProblem: problemOf(last),
    };
  }
  return { kind: 'needs-human', why: 'wall', canFileLate: true, lastProblem };
}

export function stateOfPunch(db: StampStore, punch: Punch, nowMs: number): CardState {
  return cardState(punch, attemptsOf(db, punch.id), decisionsOf(db, punch.id), laterCardFiled(db, punch), nowMs);
}

export function punchById(db: StampStore, id: number): Punch | undefined {
  const r = db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
  return r === undefined ? undefined : rowToPunch(r);
}

/** Every card that is neither filed nor covered — the outbox's work and the queue's content — oldest first. */
export function openPunches(db: StampStore): Punch[] {
  return db
    .prepare(
      `SELECT p.* FROM punches p
       WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.punch_id = p.id AND a.outcome = 'filed')
         AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.punch_id = p.id AND d.kind = 'covered')
       ORDER BY p.event_ms, p.id`,
    )
    .all()
    .map(rowToPunch);
}

/** How many cards the outbox is still sending (in their 15 minutes, or late with a reason) — not those awaiting a human. */
export function cardsOnTheirWay(db: StampStore, nowMs: number): number {
  return openPunches(db).filter((p) => ['sending', 'sending-late'].includes(stateOfPunch(db, p, nowMs).kind)).length;
}

/** The one card's submission, exactly as Card_v1.xsd wants it (validated by the ministry-derived schema). */
export function submissionFor(punch: Punch, employerAfm: string, fAitiologia: '' | WorkCardDelayReason): WorkCardSubmission {
  return WorkCardSubmission.parse({
    Cards: {
      Card: [
        {
          f_afm_ergodoti: employerAfm,
          f_aa: punch.branch,
          f_comments: '',
          Details: {
            CardDetails: [
              {
                f_afm: punch.afm,
                f_eponymo: punch.surname,
                f_onoma: punch.firstName,
                f_type: punch.fType,
                f_reference_date: punch.referenceDate,
                f_date: punch.fDate,
                f_aitiologia: fAitiologia,
              },
            ],
          },
        },
      ],
    },
  });
}

/** What the outbox needs of the client: the filing and the proof PDF. */
export type FilingClient = Pick<ErganiClient, 'submitWorkCard' | 'fetchSubmissionPdf'>;

export type OutboxEvent =
  | { kind: 'attempt'; punch: Punch; attempt: Attempt }
  | { kind: 'evidence'; attemptId: number; ok: boolean };

export interface OutboxOptions {
  db: StampStore;
  /** One per branch (`f_aa` → its login's client). A card is filed with its own branch's. */
  clients: ReadonlyMap<string, FilingClient>;
  employerAfm: string;
  now: () => number;
  /** One line per event, for the journal. ⛔ Never a name, an ΑΦΜ or a credential — card numbers and outcomes. */
  log?: (line: string) => void;
  /** Told after each attempt and evidence fetch (the alarms listen here). */
  onEvent?: (event: OutboxEvent) => void;
}

export class Outbox {
  readonly #db: StampStore;
  readonly #clients: ReadonlyMap<string, FilingClient>;
  readonly #employerAfm: string;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #onEvent: (event: OutboxEvent) => void;
  #running: Promise<void> | undefined;
  #again = false;
  #timer: NodeJS.Timeout | undefined;
  /**
   * When the outbox last made progress: a pass that completed, or an attempt it recorded. The health check reads it.
   * ⓘ An attempt counts too, so a long pass through a slow ΕΡΓΑΝΗ (20 s per request, 429 waits) does not read as
   * a stopped outbox while it is in fact working through the cards.
   */
  lastPassMs: number | undefined;

  constructor(options: OutboxOptions) {
    this.#db = options.db;
    this.#clients = options.clients;
    this.#employerAfm = options.employerAfm;
    this.#now = options.now;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#onEvent = options.onEvent ?? (() => undefined);
  }

  /** Pass every `intervalMs`, and whenever woken. */
  start(intervalMs = 2_000): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.pass(), intervalMs);
    void this.pass();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** A card was captured or a decision made: pass now. */
  wake(): void {
    void this.pass();
  }

  /** One pass — or, if one is running, one more after it. Resolves when the work it was asked for is done. */
  pass(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#passOnce();
        } while (this.#again);
      } finally {
        this.#running = undefined;
      }
    })();
    return this.#running;
  }

  async #passOnce(): Promise<void> {
    try {
      // ⓘ OLDEST FIRST among the cards due now — so when two cards of one person are both due, the earlier goes first.
      // ⚠ NOT more than that: a card waiting out its retry gap can be overtaken by a later card of the same person and
      // day, and if that later ΛΗΞΗ is filed first, rule 3's bound holds the day's ΕΝΑΡΞΗ for a human («covered» only;
      // the accountant corrects). ⚖ By design (docs/DECISIONS.md, «The clock-out is never delayed»): a ΛΗΞΗ never waits
      // behind its day's pending ΕΝΑΡΞΗ. A «fresh before late» order was tried and dropped (it made the overtaking more
      // likely); its own cost is stated in docs/KNOWN-LIMITS.md («Late sends and a slow ΕΡΓΑΝΗ»).
      for (const punch of openPunches(this.#db)) {
        const state = stateOfPunch(this.#db, punch, this.#now());
        if ((state.kind === 'sending' || state.kind === 'sending-late') && state.nextAttemptMs <= this.#now()) {
          await this.#attempt(punch, state);
        }
      }
      // At most one proof fetch per pass: a card always goes before a PDF.
      await this.#oneEvidenceFetch();
      // ⚠ Only a pass that COMPLETED counts: `/health` and the page read this, and a pass that keeps failing (the
      // database, say) must turn them red rather than look alive while nothing is filed.
      this.lastPassMs = this.#now();
    } catch (error) {
      // A pass must never die silently: the next one runs anyway, and `/health` goes stale while they fail.
      this.#log(`outbox: pass failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #attempt(punch: Punch, state: Extract<CardState, { kind: 'sending' | 'sending-late' }>): Promise<void> {
    const late = state.kind === 'sending-late' ? state.decision : undefined;
    const fAitiologia = late?.fAitiologia ?? '';
    const startedMs = this.#now();
    let outcome: Attempt['outcome'];
    let httpStatus: number | undefined;
    let message: string | undefined;
    let receipt: { protocol: string; id: string; submitDate: string; raw: string } | undefined;

    try {
      // ⓘ Looked up inside the try: a card whose branch has no login (the store refuses to open that way, store.ts) is
      // recorded as a failed attempt, visible to a person — never a pass that stops before the other cards.
      const client = this.#clients.get(punch.branch);
      if (client === undefined) throw new Error(`no ΕΡΓΑΝΗ login is configured for branch ${punch.branch}`);
      const submission = submissionFor(punch, this.#employerAfm, fAitiologia);
      // ⛔ Written down BEFORE it leaves: if the service dies between ΕΡΓΑΝΗ taking it and the attempt row below, this
      // row is what keeps rule 3's bound (`laterCardFiled`) from sending an earlier ΕΝΑΡΞΗ after it.
      this.#db.prepare('INSERT INTO dispatches (punch_id, at_ms) VALUES (?, ?)').run(punch.id, this.#now());
      const answer = await withDeadline(state.untilMs, () => client.submitWorkCard(submission));
      const parsed = SubmissionResult.safeParse(answer);
      const first = parsed.success ? parsed.data[0] : undefined;
      // ⚠ A receipt is a NON-BLANK protocol number: it is the only proof of filing, and the PDF is fetched by it. A
      // blank one is an answer we do not recognise — asked again (safe, rule 3), never taken as filed.
      if (first !== undefined && first.protocol.trim() !== '') {
        outcome = 'filed';
        httpStatus = 200;
        receipt = { protocol: first.protocol, id: first.id, submitDate: first.submitDate, raw: JSON.stringify(answer) };
      } else {
        // A 200 with no receipt we can read. Probably filed — but with no protocol number there is no proof, so it is
        // asked again (safe, rule 3) and, at the wall, a human sees this body.
        outcome = 'failed';
        httpStatus = 200;
        message = `ΕΡΓΑΝΗ answered 200 without a recognisable receipt: ${JSON.stringify(answer)?.slice(0, 2000)}`;
      }
    } catch (error) {
      if (error instanceof ErganiError) {
        outcome = error.status === 400 ? 'refused' : 'failed';
        httpStatus = error.status;
        // ⚠ Verbatim (rule 8). `body` is ΕΡΓΑΝΗ's answer, never our request — the credential cannot be in it.
        message = error.ministryMessage ?? error.body;
      } else {
        outcome = 'failed';
        message = describe(error);
      }
    }

    const finishedMs = this.#now();
    const row = this.#db
      .prepare(
        `INSERT INTO attempts (punch_id, decision_id, started_ms, finished_ms, f_aitiologia, outcome, http_status, message,
                               protocol, ergani_id, submit_date, receipt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        punch.id,
        late?.id ?? null,
        startedMs,
        finishedMs,
        fAitiologia,
        outcome,
        httpStatus ?? null,
        message ?? null,
        receipt?.protocol ?? null,
        receipt?.id ?? null,
        receipt?.submitDate ?? null,
        receipt?.raw ?? null,
      );
    const attempt = rowToAttempt(row ?? {});
    this.lastPassMs = this.#now();
    this.#log(
      `outbox: card ${punch.id} ${outcome}${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}` +
        `${late === undefined ? '' : ` late, reason ${late.fAitiologia}`}`,
    );
    this.#onEvent({ kind: 'attempt', punch, attempt });
  }

  async #oneEvidenceFetch(): Promise<void> {
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.protocol, a.submit_date, a.finished_ms, p.branch,
                (SELECT count(*) FROM evidence e WHERE e.attempt_id = a.id) AS tries,
                (SELECT max(e.at_ms) FROM evidence e WHERE e.attempt_id = a.id) AS last_try
         FROM attempts a JOIN punches p ON p.id = a.punch_id
         WHERE a.outcome = 'filed' AND a.submit_date IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.attempt_id = a.id AND e.pdf IS NOT NULL)
         ORDER BY a.finished_ms`,
      )
      .all();
    const now = this.#now();
    for (const r of rows) {
      const tries = Number(r['tries']);
      if (now - Number(r['finished_ms']) > EVIDENCE_GIVE_UP_MS) continue;
      const gap = EVIDENCE_DELAYS_MS[tries] ?? EVIDENCE_DAILY_MS;
      const since = r['last_try'] === null ? Number(r['finished_ms']) : Number(r['last_try']);
      if (now < since + gap) continue;
      const attemptId = Number(r['id']);
      let pdf: Buffer | undefined;
      let error: string | undefined;
      try {
        const client = this.#clients.get(String(r['branch']));
        if (client === undefined) throw new Error(`no ΕΡΓΑΝΗ login is configured for branch ${String(r['branch'])}`);
        pdf = await client.fetchSubmissionPdf(String(r['protocol']), String(r['submit_date']));
      } catch (e) {
        error = e instanceof ErganiError ? `HTTP ${e.status}: ${e.ministryMessage ?? e.body}` : describe(e);
      }
      this.#db
        .prepare('INSERT INTO evidence (attempt_id, at_ms, pdf, sha256, error) VALUES (?, ?, ?, ?, ?)')
        .run(
          attemptId,
          this.#now(),
          pdf ?? null,
          pdf === undefined ? null : createHash('sha256').update(pdf).digest('hex'),
          error ?? null,
        );
      this.#log(`outbox: proof PDF for attempt ${attemptId} ${pdf === undefined ? 'not fetched' : 'stored'}`);
      this.#onEvent({ kind: 'evidence', attemptId, ok: pdf !== undefined });
      return;
    }
  }
}

/**
 * Filed cards whose proof PDF is still missing after every scheduled try — for the owner (the `queue` command, and a
 * push in the alarms). The ΑΡΙΘΜΟΣ ΠΡΩΤΟΚΟΛΛΟΥ is held for each; the PDF is the second half of the proof.
 */
export function cardsMissingProof(db: StampStore): Array<{ punchId: number; protocol: string; tries: number }> {
  return db
    .prepare(
      `SELECT a.punch_id, a.protocol, (SELECT count(*) FROM evidence e WHERE e.attempt_id = a.id) AS tries
       FROM attempts a
       WHERE a.outcome = 'filed'
         AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.attempt_id = a.id AND e.pdf IS NOT NULL)
         AND (SELECT count(*) FROM evidence e WHERE e.attempt_id = a.id) >= ?
       ORDER BY a.finished_ms`,
    )
    .all(EVIDENCE_DELAYS_MS.length)
    .map((r) => ({ punchId: Number(r['punch_id']), protocol: String(r['protocol']), tries: Number(r['tries']) }));
}

/** An error, in one line, for the record and the page. ⓘ Never carries the request, so never the credential. */
function describe(error: unknown): string {
  if (error instanceof DeadlineReachedError) return error.message;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'no answer from ΕΡΓΑΝΗ in time (timeout)';
    const cause = (error as { cause?: unknown }).cause;
    const why = cause instanceof Error ? ` — ${cause.message}` : '';
    return `${error.name}: ${error.message}${why}`.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The human queue: a person decides what happens to a card the outbox could not file in time
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type DecisionInput =
  | { kind: 'file_late'; fAitiologia: WorkCardDelayReason }
  | { kind: 'covered' };

/**
 * Record a human's decision about a card in the queue. ⛔ Only for a card that needs a human — a card still inside its
 * window is the outbox's, and a decision cannot be used to file early or twice. «File late» is refused for a card held
 * by rule 3's bound. Who decided (their name, or «ο εργοδότης») and where is kept.
 */
export function decide(
  db: StampStore,
  punchId: number,
  input: DecisionInput,
  by: { employeeId: number | undefined; label: string; deviceId: number | undefined },
  nowMs: number,
): Decision {
  const punch = punchById(db, punchId);
  if (punch === undefined) throw new Error('no such card.');
  const state = stateOfPunch(db, punch, nowMs);
  if (state.kind !== 'needs-human') throw new Error('this card does not need a decision now.');
  if (input.kind === 'file_late' && !state.canFileLate) {
    throw new Error('this ΕΝΑΡΞΗ cannot be sent: a later card of the same day was already filed (the accountant corrects it).');
  }
  const row = db
    .prepare(
      `INSERT INTO decisions (punch_id, kind, f_aitiologia, by_employee_id, by_label, device_id, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      punchId,
      input.kind,
      input.kind === 'file_late' ? input.fAitiologia : null,
      by.employeeId ?? null,
      by.label,
      by.deviceId ?? null,
      nowMs,
    );
  return rowToDecision(row ?? {});
}
