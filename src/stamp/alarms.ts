// SPDX-License-Identifier: EUPL-1.2
import type { ReadClient } from '../ergani/exbase.js';
import { ENARXI, LIXI } from '../ergani/types.js';
import { athensInstant, athensTime, clockOf, shortGreek } from './athens.js';
import { rowToPunch, type Punch } from './capture.js';
import { withoutAfm, type Push, type PushSender } from './notify.js';
import { cardsMissingProof, openPunches, punchById, stateOfPunch, WALL_MS } from './outbox.js';
import { declaredDays, ensureSchedule, isQuietDay, latestScheduleRead, scheduleForDay } from './schedule.js';
import type { BoardWarning } from './server.js';
import { allStaff, personById, stampingStaff } from './staff.js';
import type { StampStore } from './store.js';

/**
 * THE ALARMS — on the reception page AND on the owner's phone, naming the person (the owner needs to know WHO is having
 * a problem — docs/DECISIONS.md), never their ΑΦΜ. With more than one branch, each alarm names the branch too.
 *
 * Two families:
 *   · A CARD THAT DID NOT GO THROUGH (from the outbox): refused by ΕΡΓΑΝΗ · not filed after 5 minutes · the 15-minute
 *     wall · held by rule 3's bound · a late filing that failed — and, once filed after all, «στάλθηκε τελικά».
 *     (The page already shows these from the outbox itself; here they become pushes.)
 *   · (to the owner only, once a day) filed cards whose proof PDF is still missing after every scheduled try.
 *   · SOMEONE FORGOT TO STAMP (same day), each declared interval on its own (a σπαστό ωράριο is two): no ΕΝΑΡΞΗ by an
 *     interval's start + 20′ · still «in» at an interval's end + 30′ (21:00 when no end is declared) · a ΛΗΞΗ with no
 *     ΕΝΑΡΞΗ that day · the schedule could not be read · a person in ΕΡΓΑΝΗ's schedule who is not on the page. Who is
 *     due comes from each branch's own schedule in ΕΡΓΑΝΗ, a month late by the ministry's rule (schedule.ts — its limits
 *     are stated there); what she stamped is read at EVERY branch, so a card at another branch than the one her
 *     schedule names still counts.
 *
 * Each alarm has a KEY; it is pushed once (a failed push is retried each minute, then every ten minutes for as long as
 * the alarm holds — never given up while it is still true). The page shows it for as long as it holds.
 * ⓘ The thresholds are defaults: +20′ is short of a 120′ flexible arrival on purpose — a planned late arrival raises it,
 * and it clears when she stamps.
 */

export const NO_START_GRACE_MS = 20 * 60_000;
export const NO_END_GRACE_MS = 30 * 60_000;
/** When an open ΕΝΑΡΞΗ with no declared end is called forgotten. */
export const NO_END_FALLBACK = '21:00';
/** A schedule that could not be read is pushed only from this hour (the page shows it at once). */
export const SCHEDULE_PUSH_FROM = '07:30';
const PUSH_RETRY_MS = 60_000;
/** After this many failed tries a push is tried every `PUSH_SLOW_RETRY_MS` — slower, never given up (see `#due`). */
const PUSH_MAX_FAILURES = 10;
const PUSH_SLOW_RETRY_MS = 10 * 60_000;

export interface AlarmLine {
  key: string;
  /** On the page — `undefined` for the card alarms the page already shows from the outbox. */
  desk: BoardWarning | undefined;
  push: Push | undefined;
}

const CARD_OF = { '0': 'ΕΝΑΡΞΗΣ', '1': 'ΛΗΞΗΣ' } as const;

/** A card's time as a push says it: the clock alone for today's, the day too for an older one (it can wait overnight). */
function cardTime(ms: number, nowMs: number): string {
  return athensTime(ms).date === athensTime(nowMs).date ? clockOf(ms) : shortGreek(ms);
}

function punchesOn(db: StampStore, day: string): Punch[] {
  return db.prepare('SELECT * FROM punches WHERE reference_date = ? ORDER BY event_ms, id').all(day).map(rowToPunch);
}

/**
 * A person's stints on one day, in time order: an ΕΝΑΡΞΗ opens one, the next ΛΗΞΗ closes it (`endMs` undefined while
 * open). A second ΕΝΑΡΞΗ while one is open opens nothing new; a ΛΗΞΗ with nothing open closes nothing — the same
 * earliest-ΕΝΑΡΞΗ / latest-ΛΗΞΗ reading ΕΡΓΑΝΗ gives a day's marks (docs/RULES.md, «Split shifts»).
 */
export function stintsOf(cards: readonly Punch[]): Array<{ startMs: number; endMs: number | undefined }> {
  const stints: Array<{ startMs: number; endMs: number | undefined }> = [];
  let open: { startMs: number; endMs: number | undefined } | undefined;
  for (const card of cards) {
    if (card.fType === ENARXI) {
      if (open === undefined) {
        open = { startMs: card.eventMs, endMs: undefined };
        stints.push(open);
      }
    } else if (open !== undefined) {
      open.endMs = card.eventMs;
      open = undefined;
    }
  }
  return stints;
}

/** A branch, as the alarms need it. `label` is empty when the employer has one branch: the alarms then name none. */
export interface AlarmBranch {
  code: string;
  label: string;
  /** Whether this branch's page reads ΕΡΓΑΝΗ's schedule (`STAMP_BRANCH_<n>_SCHEDULE`, config.ts). */
  fromSchedule: boolean;
}

/** «, Κέντρο» — how an alarm names a branch; nothing for an employer with one branch. */
export type Where = (branch: string) => string;

export function whereOf(branches: readonly AlarmBranch[]): Where {
  return (code) => {
    const label = branches.find((b) => b.code === code)?.label ?? '';
    return branches.length > 1 && label !== '' ? `, ${label}` : '';
  };
}

/**
 * The «someone forgot to stamp» alarms holding now, for the employer's `branches`.
 * ⓘ A branch that reads no schedule (`fromSchedule` false — config.ts) holds no one to one: no «not stamped in»,
 * «Δεν διάβασα» or «not on the page» line from it, whatever `schedule_reads` holds for the day.
 * ⭐ What she stamped is read across every branch: an ΕΝΑΡΞΗ at one branch and the ΛΗΞΗ at another are one stint.
 */
export function forgotAlarms(db: StampStore, nowMs: number, title: string, branches: readonly AlarmBranch[]): AlarmLine[] {
  const today = athensTime(nowMs).date;
  const where = whereOf(branches);
  const lines: AlarmLine[] = [];
  const red = (key: string, text: string, priority: Push['priority'] = 4): AlarmLine => ({
    key,
    desk: { key, level: 'red', text },
    push: { title, message: text, priority },
  });

  // LIVE AT A BRANCH FROM THE DAY OF ITS FIRST CARD ON THE PAGE (docs/INSTALL.md, «Η πρώτη πραγματική κάρτα»). Before it,
  // the branch's staff still stamp another way, and the page has nothing to hold anyone to there: every «forgot to
  // stamp» line from its schedule — on the desk, and pushed naming the person — would be false. Read from the record,
  // so it cannot be forgotten.
  const firstDays = new Map(
    db
      .prepare('SELECT branch, min(reference_date) AS day FROM punches GROUP BY branch')
      .all()
      .map((r) => [String(r['branch']), String(r['day'])]),
  );
  const live = branches.filter((b) => {
    const first = firstDays.get(b.code);
    return first !== undefined && first <= today;
  });
  if (live.length === 0) return [];

  const schedules = live
    .filter((b) => b.fromSchedule)
    .map((b) => {
      const read = scheduleForDay(db, b.code, today);
      return { branch: b, read, declared: new Map((read?.rows === undefined ? [] : declaredDays(read.rows)).map((d) => [d.afm, d])) };
    });
  const quiet = isQuietDay(db, today);
  const cards = punchesOn(db, today);

  for (const person of stampingStaff(db)) {
    const mine = cards.filter((c) => c.employeeId === person.id);
    const stints = stintsOf(mine);
    const open = stints.at(-1)?.endMs === undefined ? stints.at(-1) : undefined;
    const ends: number[] = [];
    let raised = false;

    for (const { branch, declared } of schedules) {
      const day = declared.get(person.afm);
      const intervals = day === undefined || day.off ? [] : day.intervals;

      // Interval i is «not stamped in» while no stint of hers overlaps it, from its start + 20′ — each interval of a
      // σπαστό ωράριο on its own (schedule.ts, DeclaredDay). ⚠ Matched by TIME, never by counting the day's cards: a
      // second morning ΕΝΑΡΞΗ, or an errand out and back in, must not stand in for a forgotten afternoon ΕΝΑΡΞΗ.
      if (!quiet) {
        intervals.forEach((iv, i) => {
          const from = athensInstant(today, iv.start);
          const to = iv.end > iv.start ? athensInstant(today, iv.end) : Infinity;
          const covered = stints.some((s) => s.startMs < to && (s.endMs === undefined || s.endMs > from));
          if (!covered && nowMs >= from + NO_START_GRACE_MS) {
            lines.push(
              red(
                `no-start:${person.id}:${today}:${branch.code}:${i}`,
                `${person.displayName} — δεν έχει χτυπήσει κάρτα ΕΝΑΡΞΗΣ (βάρδια από ${iv.start}${where(branch.code)}).`,
              ),
            );
          }
        });
      }

      // Still «in» past the end + 30′ of an interval her open stint began before — or past every declared end (below).
      for (const [i, iv] of intervals.entries()) {
        if (iv.end <= iv.start) continue;
        const end = athensInstant(today, iv.end);
        ends.push(end + NO_END_GRACE_MS);
        if (open !== undefined && open.startMs < end && nowMs >= end + NO_END_GRACE_MS) {
          raised = true;
          lines.push(
            red(
              `no-end:${person.id}:${today}:${branch.code}:${i}`,
              `${person.displayName} — δεν έχει χτυπήσει κάρτα ΛΗΞΗΣ (ΕΝΑΡΞΗ ${clockOf(open.startMs)}, βάρδια ως ${iv.end}${where(branch.code)}).`,
            ),
          );
        }
      }
    }

    // The catch-all for a card past every declared end (an extra stint after the shift, or no schedule at all): from
    // 21:00, or from the last declared end + 30′ when that is later.
    if (open !== undefined && !raised && nowMs >= Math.max(athensInstant(today, NO_END_FALLBACK), ...ends)) {
      lines.push(red(`no-end:${person.id}:${today}:late`, `${person.displayName} — δεν έχει χτυπήσει κάρτα ΛΗΞΗΣ (ΕΝΑΡΞΗ ${clockOf(open.startMs)}).`));
    }

    const firstEnd = mine.find((c) => c.fType === LIXI);
    if (firstEnd !== undefined && !mine.some((c) => c.fType === ENARXI && c.eventMs <= firstEnd.eventMs)) {
      lines.push(
        red(
          `end-without-start:${person.id}:${today}`,
          `${person.displayName} — χτύπησε ΛΗΞΗ (${clockOf(firstEnd.eventMs)}${where(firstEnd.branch)}) χωρίς ΕΝΑΡΞΗ σήμερα. Ενημερώστε τον λογιστή.`,
        ),
      );
    }
  }

  const known = new Set(allStaff(db).map((p) => p.afm));
  const strangers = new Set<string>();
  for (const { branch, read, declared } of schedules) {
    if (read === undefined) {
      if (latestScheduleRead(db, branch.code, today)?.error !== undefined) {
        const key = `schedule-unknown:${branch.code}:${today}`;
        const text =
          `Δεν διάβασα το ωράριο${where(branch.code) === '' ? '' : ` (${branch.label})`} από την ΕΡΓΑΝΗ: σήμερα ο έλεγχος ` +
          '«δεν χτύπησε ΕΝΑΡΞΗ» δεν λειτουργεί εκεί — ο έλεγχος για ΛΗΞΗ λειτουργεί κανονικά.';
        lines.push({
          key,
          desk: { key, level: 'amber', text },
          push: nowMs >= athensInstant(today, SCHEDULE_PUSH_FROM) ? { title, message: text, priority: 3 } : undefined,
        });
      }
      continue;
    }
    for (const d of declared.values()) if (d.intervals.length > 0 && !known.has(d.afm)) strangers.add(d.afm);
  }
  if (strangers.size > 0) {
    const key = `unknown-person:${today}`;
    const text =
      `Στο ωράριο της ΕΡΓΑΝΗΣ για σήμερα ${strangers.size === 1 ? 'υπάρχει 1 άτομο' : `υπάρχουν ${strangers.size} άτομα`} ` +
      'που δεν είναι στη σελίδα της υποδοχής. Ο εργοδότης ας το ελέγξει (εντολή check).';
    lines.push({ key, desk: { key, level: 'amber', text }, push: { title, message: text, priority: 3 } });
  }
  return lines;
}

/** The pushes for cards that did not go through. (The page shows these from the outbox; `desk` is undefined.) */
export function cardAlarms(db: StampStore, nowMs: number, title: string, where: Where = () => ''): AlarmLine[] {
  const lines: AlarmLine[] = [];
  const push = (key: string, message: string, priority: Push['priority']) => lines.push({ key, desk: undefined, push: { title, message, priority } });
  for (const punch of openPunches(db)) {
    const state = stateOfPunch(db, punch, nowMs);
    const name = personById(db, punch.employeeId)?.displayName ?? '—';
    const what = `${name} — η κάρτα ${CARD_OF[punch.fType]} (${cardTime(punch.eventMs, nowMs)}${where(punch.branch)})`;
    if (state.kind === 'sending') {
      if (state.overdue) {
        push(
          `overdue:${punch.id}`,
          // ⚖ «One arrival, one card» (docs/DECISIONS.md): a card the page holds is never stamped a second time on
          // CardScanner; it keeps trying, and what does not get through goes to the late-send list with a reason.
          `${what} δεν έχει φτάσει στην ΕΡΓΑΝΗ εδώ και 5 λεπτά. Ξαναδοκιμάζω ως τις ${clockOf(state.untilMs)}.`,
          4,
        );
      }
    } else if (state.kind === 'needs-human') {
      const text =
        state.why === 'wall'
          // Pushed at the 14-minute stop (outbox.ts, LAST_SEND_MS), and said as of the moment it is SENT: before the 15
          // minutes it is not late YET — never «late» a minute early; a push that goes out after them (a restart, the
          // push server down) says «late». No CardScanner prompt («One arrival, one card»): the card goes to the
          // late-send list.
          ? (nowMs < punch.eventMs + WALL_MS
              ? `${what} ΔΕΝ στάλθηκε, και δεν θα σταλεί πια αυτόματα — στις ${clockOf(punch.eventMs + WALL_MS)} γίνεται ` +
                'εκπρόθεσμη. '
              : `${what} ΔΕΝ στάλθηκε μέσα στα 15 λεπτά — είναι εκπρόθεσμη. `) +
            'Στη σελίδα της υποδοχής: «Τι κάνω;» — αιτία, για εκπρόθεσμη αποστολή. ' +
            'Και: ειδοποίηση στην Επιθεώρηση Εργασίας όταν αρχίζει ΚΑΙ όταν τελειώνει το πρόβλημα.'
          : state.why === 'blocked'
            ? `${what} δεν θα σταλεί: μεταγενέστερη κάρτα της ίδιας μέρας έχει ήδη σταλεί, ή μπορεί να έχει φτάσει, στην ΕΡΓΑΝΗ. Ενημερώστε τον λογιστή.`
            : `${what}: η εκπρόθεσμη αποστολή δεν πέρασε σε 2 ώρες. Ανοίξτε τη σελίδα της υποδοχής.`;
      push(`queue:${punch.id}:${state.why}`, text, 5);
    }
  }
  // A REFUSAL is read from the recorded attempts, not from the cards still open: the next try, ten seconds later, can
  // file the card before the alarms look again (every 30 s), and the owner must still hear that ΕΡΓΑΝΗ said no — then
  // «στάλθηκε τελικά» (`resolvedAlarms`). Pushed once per card, with ΕΡΓΑΝΗ's latest sentence (no ΑΦΜ).
  const refused = db
    .prepare(
      `SELECT punch_id, message FROM attempts a
       WHERE outcome = 'refused' AND finished_ms > ?
         AND NOT EXISTS (SELECT 1 FROM attempts b WHERE b.punch_id = a.punch_id AND b.outcome = 'refused'
                         AND (b.finished_ms > a.finished_ms OR (b.finished_ms = a.finished_ms AND b.id > a.id)))
       ORDER BY finished_ms, id`,
    )
    .all(nowMs - 24 * 3_600_000);
  for (const r of refused) {
    const punch = punchById(db, Number(r['punch_id']));
    if (punch === undefined) continue;
    const state = stateOfPunch(db, punch, nowMs);
    const name = personById(db, punch.employeeId)?.displayName ?? '—';
    const what = `${name} — η κάρτα ${CARD_OF[punch.fType]} (${cardTime(punch.eventMs, nowMs)}${where(punch.branch)})`;
    push(
      `refused:${punch.id}`,
      `${what} δεν έγινε δεκτή από την ΕΡΓΑΝΗ: «${withoutAfm(String(r['message'] ?? ''))}». ` +
        (state.kind === 'sending' ? `Ξαναδοκιμάζω ως τις ${clockOf(state.untilMs)}. ` : '') +
        'Ανοίξτε τη σελίδα της υποδοχής.',
      4,
    );
  }
  return lines;
}

/**
 * Filed cards whose proof PDF is still missing after every scheduled try (outbox.ts asks again daily). Once a day, to
 * the owner only — the staff can do nothing about it, and the ΑΡΙΘΜΟΣ ΠΡΩΤΟΚΟΛΛΟΥ is held for each.
 */
export function proofAlarms(db: StampStore, nowMs: number, title: string): AlarmLine[] {
  const missing = cardsMissingProof(db);
  if (missing.length === 0) return [];
  const message =
    `${missing.length === 1 ? '1 κάρτα στάλθηκε' : `${missing.length} κάρτες στάλθηκαν`} στην ΕΡΓΑΝΗ (με αριθμό πρωτοκόλλου), ` +
    'αλλά το αποδεικτικό PDF δεν έχει ληφθεί ακόμη· ξαναζητείται κάθε μέρα. Λίστα: εντολή queue.';
  return [{ key: `proof-missing:${athensTime(nowMs).date}`, desk: undefined, push: { title, message, priority: 3 } }];
}

/** «Στάλθηκε τελικά» — for every card the owner was alarmed about that has since been filed. */
export function resolvedAlarms(db: StampStore, nowMs: number, title: string, where: Where = () => ''): AlarmLine[] {
  // Every card the owner was warned about and not yet told is settled — however long ago the warning was: a card
  // warned about on Friday and settled on Monday still owes its «στάλθηκε τελικά». (A 48-hour window once lost it.)
  const alarmed = db
    .prepare(
      `SELECT DISTINCT key FROM pushes WHERE outcome = 'sent'
         AND (key LIKE 'overdue:%' OR key LIKE 'refused:%' OR key LIKE 'queue:%')`,
    )
    .all()
    .map((r) => String(r['key']));
  const told = new Set(
    db
      .prepare("SELECT key FROM pushes WHERE outcome = 'sent' AND key LIKE 'resolved:%'")
      .all()
      .map((r) => Number(String(r['key']).split(':')[1])),
  );
  const ids = new Set(alarmed.map((key) => Number(key.split(':')[1])).filter((id) => !told.has(id)));
  const lines: AlarmLine[] = [];
  for (const id of ids) {
    const punch = punchById(db, id);
    if (punch === undefined) continue;
    const state = stateOfPunch(db, punch, nowMs);
    const name = personById(db, punch.employeeId)?.displayName ?? '—';
    const what = `${name} — η κάρτα ${CARD_OF[punch.fType]} (${cardTime(punch.eventMs, nowMs)}${where(punch.branch)})`;
    if (state.kind === 'filed') {
      lines.push({
        key: `resolved:${id}`,
        desk: undefined,
        push: { title, message: `${what} στάλθηκε τελικά στην ΕΡΓΑΝΗ (${clockOf(state.filedMs)}${state.late ? ', εκπρόθεσμα' : ''}) ✓`, priority: 3 },
      });
    } else if (state.kind === 'covered') {
      lines.push({
        key: `resolved:${id}`,
        desk: undefined,
        push: { title, message: `${what}: καταγράφηκε ότι καλύφθηκε (CardScanner ή λογιστής) — από ${state.byLabel}.`, priority: 3 },
      });
    }
  }
  return lines;
}

/**
 * While the owner's phone is NOT getting the alarms — an alarm holding NOW (`owed`: the keys of the lines holding at
 * this moment) whose latest push failed (the push server down, its login lost) — the desk says so, so someone tells the
 * owner. It clears with the next push that gets through (a failed push is retried while its alarm holds,
 * `Alarms.#due`), or the moment no such alarm holds: nothing is being missed then. ⚠ Not «the latest push failed»: an
 * alarm that stopped holding before its retry would leave that row failed for days, while the push server worked.
 * No push configured: no pushes, no line.
 */
export function pushChannelWarning(db: StampStore, owed: readonly string[]): BoardWarning[] {
  const latest = db.prepare('SELECT outcome FROM pushes WHERE key = ? ORDER BY at_ms DESC, id DESC LIMIT 1');
  if (!owed.some((key) => latest.get(key)?.['outcome'] === 'failed')) return [];
  return [
    {
      key: 'push-failing',
      level: 'amber',
      text: 'Οι ειδοποιήσεις στο κινητό του εργοδότη δεν περνούν αυτή τη στιγμή — ενημερώστε τον εργοδότη.',
    },
  ];
}

export interface AlarmsOptions {
  db: StampStore;
  /** The employer's branches, in order. */
  branches: readonly AlarmBranch[];
  /**
   * For the schedule reads — each branch's client (its own login), narrowed to what a read needs, for the branches
   * that read one. A branch missing here reads no schedule (`STAMP_BRANCH_<n>_SCHEDULE=none`, config.ts): no call to
   * ΕΡΓΑΝΗ, no «not stamped in» line, no «Δεν διάβασα» line from it.
   */
  readers: ReadonlyMap<string, ReadClient>;
  /** Unset: no phone push (the page still shows everything). */
  send: PushSender | undefined;
  now: () => number;
  /** The push title, e.g. «ΕΡΓΑΝΗ — Οδοντιατρείο Παράδειγμα». */
  title: string;
  log?: (line: string) => void;
}

export class Alarms {
  readonly #o: AlarmsOptions;
  readonly #log: (line: string) => void;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #reading: Promise<void> | undefined;
  #stopping = false;

  constructor(options: AlarmsOptions) {
    this.#o = options;
    this.#log = options.log ?? ((line) => console.log(line));
  }

  start(intervalMs = 30_000): void {
    if (this.#timer !== undefined) return;
    this.#stopping = false;
    if (this.#o.send === undefined) this.#log('alarms: no phone push configured — the page only');
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    // ⚠ main.ts closes the store the moment this resolves. So: no NEW schedule read from here on (the pass in flight
    // would start one after this line, against a closed store), then the pass in flight, then the read already running.
    this.#stopping = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
    await this.#reading;
  }

  /** The page's extra lines: the «forgot to stamp» alarms holding now, and whether the owner's phone gets the alarms. No network. */
  deskWarnings(nowMs: number): BoardWarning[] {
    const { db, title } = this.#o;
    const forgot = forgotAlarms(db, nowMs, title, this.#branches());
    // Every line that would be pushed now — the same four the pass pushes, all read from the record.
    const owed = [...this.#cardLines(nowMs), ...forgot]
      .filter((l) => l.push !== undefined)
      .map((l) => l.key);
    return [...forgot.flatMap((l) => (l.desk === undefined ? [] : [l.desk])), ...pushChannelWarning(db, owed)];
  }

  tick(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    // ⚠ An alarm pass that fails (a database error, say) is logged and the next one tries again — it must never become
    // an unhandled rejection: Node would end the whole service, page and outbox, in clinic hours (docs/RULES.md rule 5).
    this.#running = this.#tickOnce()
      .catch((error: unknown) => {
        this.#log(`alarms: pass failed — ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #tickOnce(): Promise<void> {
    const { db, now, title } = this.#o;
    // ⚠ NO PASS EVER WAITS ON ΕΡΓΑΝΗ. The schedule read can take minutes when ΕΡΓΑΝΗ is struggling (timeouts, 429
    // waits) — exactly when a card is refused or reaches its 15 minutes, and the owner must hear of it at once
    // (docs/RULES.md rule 5). So the read runs on its own (`#readSchedule`, one at a time) and every pass, every 30 s, sends
    // the card alarms whatever the read is doing; the «forgot to stamp» alarms use the latest schedule held.
    // (Awaiting the read inside the pass held back every later pass too: one pass runs at a time.)
    if (this.#o.send !== undefined) await this.#pushAll(this.#cardLines(now()));
    void this.#readSchedule();
    if (this.#o.send === undefined) return;
    await this.#pushAll(forgotAlarms(db, now(), title, this.#branches()));
  }

  /** The branches as the alarms see them: a branch reads the schedule only when it has a reader. */
  #branches(): AlarmBranch[] {
    return this.#o.branches.map((b) => ({ ...b, fromSchedule: b.fromSchedule && this.#o.readers.has(b.code) }));
  }

  /** The card, «στάλθηκε τελικά» and proof lines — every push that does not come from a schedule. */
  #cardLines(nowMs: number): AlarmLine[] {
    const { db, title } = this.#o;
    const where = whereOf(this.#o.branches);
    return [...cardAlarms(db, nowMs, title, where), ...resolvedAlarms(db, nowMs, title, where), ...proofAlarms(db, nowMs, title)];
  }

  /**
   * The day's schedule reads — every branch that reads one, one after another — at most one round at a time, never
   * awaited by a pass (only by `stop`).
   */
  #readSchedule(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    const { db, now, readers } = this.#o;
    if (readers.size === 0) return Promise.resolve();
    this.#reading ??= (async () => {
      for (const [branch, reader] of readers) {
        if (this.#stopping) return;
        await ensureSchedule(db, reader, now()).catch((error: unknown) =>
          this.#log(`alarms: schedule read of branch ${branch} failed — ${error instanceof Error ? error.name : 'error'}`),
        );
      }
    })().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  /** Push each line that is due (`#due`), recording every outcome. */
  async #pushAll(lines: readonly AlarmLine[]): Promise<void> {
    const { db, now } = this.#o;
    const send = this.#o.send;
    if (send === undefined) return;
    const t = now();
    for (const line of lines) {
      if (line.push === undefined || !this.#due(line.key, t)) continue;
      try {
        if ((await send(line.push, line.key)) === 'off') continue; // nothing sent, nothing recorded: asked again next pass
        db.prepare("INSERT INTO pushes (key, at_ms, outcome) VALUES (?, ?, 'sent')").run(line.key, now());
        this.#log(`alarms: pushed ${line.key.split(':')[0]}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : 'error';
        db.prepare("INSERT INTO pushes (key, at_ms, outcome, error) VALUES (?, ?, 'failed', ?)").run(line.key, now(), why);
        this.#log(`alarms: push failed (${line.key.split(':')[0]}) — ${why}`);
      }
    }
  }

  /** Not yet sent; and, if it failed before, not too recently and not too often. */
  #due(key: string, nowMs: number): boolean {
    const history = this.#o.db.prepare('SELECT outcome, at_ms FROM pushes WHERE key = ? ORDER BY at_ms').all(key);
    if (history.some((h) => h['outcome'] === 'sent')) return false;
    // ⚠ NEVER GIVEN UP while the alarm still holds (this is asked only for alarms holding now): the push server can be down for
    // longer than ten minutes, and the 14-minute alarm the owner must act on (docs/RULES.md rule 5) has to reach him when it
    // is back. After the first ten tries, every ten minutes.
    const last = history.at(-1);
    const gap = history.length >= PUSH_MAX_FAILURES ? PUSH_SLOW_RETRY_MS : PUSH_RETRY_MS;
    return last === undefined || nowMs - Number(last['at_ms']) >= gap;
  }
}
