// SPDX-License-Identifier: EUPL-1.2
import { randomBytes } from 'node:crypto';
import { makerMark } from '../assets.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { CardEventType, WorkCardDelayReason } from '../ergani/types.js';
import { athensTime } from './athens.js';
import { ownHistoryOf } from './history.js';
import { capturePunch, currentCardOf, lastPunchOf, suggestedType } from './capture.js';
import { deviceByToken, redeemEnrollment, type Device } from './devices.js';
import { withoutAfm } from './notify.js';
import { decide, openPunches, punchById, stateOfPunch, type CardState, type Problem } from './outbox.js';
import { APP_CSS, APP_JS, notEnrolledPage, PAGE_HTML } from './page.js';
import { checkPin, chooseOwnPin, personById, stampingStaff, type PinCheck, type VerifiedPerson } from './staff.js';
import { branchRetired } from './branch-status.js';
import type { StampStore } from './store.js';

/**
 * THE RECEPTION PAGE'S SERVER — plain `node:http`, no framework: a handful of routes, all small enough to read.
 *
 * ── WHO MAY SEE AND DO WHAT ─────────────────────────────────────────────────────────────────────────
 *   · REACH: the page is published on a private address only — the practice's own network, or a private overlay
 *     network such as Tailscale (docs/INSTALL.md; setup refuses a public address). Never the public internet.
 *   · SEE: only an ENROLLED device (`devices.ts`) gets the page or any data. Anything else sees one Greek sentence.
 *     A device is enrolled at ONE branch and sees that branch's page: its heading, its queue, its cards in flight —
 *     and the employer's staff, who may stamp at any branch.
 *   · STAMP: only with the person's own PIN, through a short-lived single-use ticket — PIN → (choose own PIN) →
 *     ΕΝΑΡΞΗ/ΛΗΞΗ → card — good only while her last card is still the one her screen shows.
 *     ⛔ There is no route that writes a card for someone else (docs/RULES.md rule 1).
 *   · DECIDE (the human queue): any person who stamps here, with their own PIN, recorded by name — for a card of the
 *     device's own branch.
 *
 * ── WHAT IT NEVER SENDS ──────────────────────────────────────────────────────────────────────────────
 * No ΑΦΜ, ever: the page shows the names the owner set (display names). ΕΡΓΑΝΗ's sentences are shown verbatim.
 * POSTs must be JSON from this page's own origin (an `Origin` check), so another site open on the same computer
 * cannot drive it.
 */

export interface ServerHooks {
  /** The outbox: woken after a card or a decision; its last pass feeds `/health`. */
  outbox: { wake(): void; readonly lastPassMs: number | undefined };
  /** Extra lines for the board (the alarms add theirs here). */
  warnings?: (nowMs: number) => BoardWarning[];
}

/** A branch's page, as the server shows it. */
export interface BranchPage {
  code: string;
  /** The page heading: the employer, and the branch when there is more than one. */
  heading: string;
  inspectorateEmail: string | undefined;
}

export interface StampServerOptions {
  db: StampStore;
  hooks: ServerHooks;
  instance: string;
  /** One per branch of the employer. */
  branches: readonly BranchPage[];
  cookieSecure: boolean;
  now: () => number;
  log?: (line: string) => void;
}

export interface BoardWarning {
  /** Stable, so the page beeps once per new warning. */
  key: string;
  level: 'red' | 'amber';
  text: string;
}

/**
 * No progress for this long means the outbox has stopped: `/health` fails and the page turns red. A healthy outbox
 * passes every 2 s; one attempt can take a request timeout (20 s) plus ΕΡΓΑΝΗ's 429 waits — 90 s leaves room for
 * that, and still turns the page red within two minutes of a real stop. (Kuma's heartbeat is 180 s.)
 */
export const HEALTHY_PASS_MS = 90_000;
const TICKET_MS = 2 * 60_000;
/** The maker's mark for the page's footer (src/brand/ — not under the EUPL, see NOTICE), served by this server alone. */
const ODONTIA_MARK = makerMark();

/**
 * The device cookie's lifetime. ⚠ Browsers cap a cookie at 400 days (Chrome and Edge since 2022; the cookie standard's
 * draft says the same), so an enrolled device would silently lose its enrolment after about thirteen months. The
 * server therefore sends the same cookie again, with a fresh lifetime, at most once a day (`COOKIE_REFRESH_MS`) on any
 * request from an enrolled device: a device stays enrolled until it is revoked.
 */
const DEVICE_COOKIE_S = 400 * 24 * 3600;
const COOKIE_REFRESH_MS = 24 * 3_600_000;
const MAX_BODY = 4_096;

interface Ticket {
  person: VerifiedPerson;
  deviceId: number;
  stage: 'choose' | 'stamp' | 'history';
  expiresMs: number;
  /** Her last card when the ticket was made — the one her screen shows and asks «again?» against. `null`: none yet. */
  lastPunchId: number | null;
}

const PinBody = z.object({ employeeId: z.number().int().positive(), pin: z.string().max(8) });
const OwnPinBody = z.object({ ticket: z.string().max(100), newPin: z.string().max(8) });
const HistoryDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
});
const HistoryBody = z.object({
  ticket: z.string().max(100), from: HistoryDay, to: HistoryDay,
  before: z.object({ at: z.number().int().safe().nonnegative(), id: z.number().int().safe().positive() }).optional(),
}).refine((input) => input.from <= input.to);
const StampBody = z.object({ ticket: z.string().max(100), type: CardEventType });
const DecideBody = z.object({
  punchId: z.number().int().positive(),
  employeeId: z.number().int().positive(),
  pin: z.string().max(8),
  kind: z.enum(['file_late', 'covered']),
  reason: WorkCardDelayReason.optional(),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export function createStampServer(options: StampServerOptions): Server {
  const { db, hooks, now } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const cookieName = `ergani_device_${options.instance.replace(/-/g, '_')}`;
  const tickets = new Map<string, Ticket>();

  function newTicket(person: VerifiedPerson, deviceId: number, stage: Ticket['stage'], lastPunchId: number | null): string {
    for (const [key, t] of tickets) if (t.expiresMs <= now()) tickets.delete(key);
    const key = randomBytes(24).toString('base64url');
    tickets.set(key, { person, deviceId, stage, expiresMs: now() + TICKET_MS, lastPunchId });
    return key;
  }

  function takeTicket(key: string, device: Device, stage: Ticket['stage']): Ticket {
    const t = tickets.get(key);
    if (t === undefined || t.expiresMs <= now() || t.deviceId !== device.id || t.stage !== stage) {
      throw new HttpError(409, { error: 'ticket', text: 'Πέρασε πολλή ώρα — ξεκινήστε πάλι από το όνομά σας.' });
    }
    tickets.delete(key);
    return t;
  }

  /** The enrolled device this request comes from, and the token it carries. */
  function deviceOf(req: IncomingMessage): { device: Device; token: string } | undefined {
    const cookies = req.headers.cookie ?? '';
    for (const part of cookies.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name !== cookieName) continue;
      const token = rest.join('=');
      const device = deviceByToken(db, token);
      return device === undefined ? undefined : { device, token };
    }
    return undefined;
  }

  const cookieFor = (token: string) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_COOKIE_S}${options.cookieSecure ? '; Secure' : ''}`;
  /** When each device's cookie was last sent, so it is sent again at most once a day (`COOKIE_REFRESH_MS`). */
  const cookieSent = new Map<number, number>();

  function pinAnswer(check: Exclude<PinCheck, { kind: 'ok' }>): HttpError {
    if (check.kind === 'wrong') {
      return new HttpError(401, { error: 'wrong', triesLeft: check.triesLeft, text: `Λάθος κωδικός. Απομένουν ${check.triesLeft} προσπάθειες.` });
    }
    if (check.kind === 'locked') {
      return new HttpError(423, { error: 'locked', untilMs: check.untilMs, text: 'Κλειδώθηκε για 10 λεπτά μετά από 5 λάθος κωδικούς. Χτυπήστε με το CardScanner και ενημερώστε τον εργοδότη.' });
    }
    return new HttpError(404, { error: 'not-here', text: 'Αυτό το όνομα δεν χτυπά κάρτα εδώ.' });
  }

  function afterPin(person: VerifiedPerson, device: Device, mustChooseOwn: boolean) {
    const last = lastPunchOf(db, person.employeeId);
    return {
      ok: true,
      ticket: newTicket(person, device.id, mustChooseOwn ? 'choose' : 'stamp', last?.id ?? null),
      mustChooseOwn,
      name: person.displayName,
      suggestion: suggestedType(db, person.employeeId, now()),
      last: last === undefined ? null : { type: last.fType, at: last.eventMs, referenceDate: last.referenceDate },
      historyRange: { from: athensTime(now()).date.slice(0, 7) + '-01', to: athensTime(now()).date },
    };
  }

  function pageOf(device: Device): BranchPage {
    const page = options.branches.find((b) => b.code === device.branch);
    // The store refuses to open with branches the configuration does not list (store.ts), so this cannot happen.
    if (page === undefined) throw new Error('a device of a branch with no page');
    return page;
  }

  /** A card this device may see and decide: one of its own branch. */
  function cardOf(device: Device, id: number) {
    const punch = punchById(db, id);
    return punch === undefined || punch.branch !== device.branch ? undefined : punch;
  }

  function board(device: Device) {
    const t = now();
    const page = pageOf(device);
    const people = stampingStaff(db).map((p) => {
      const recent = currentCardOf(db, p.id, t);
      return {
        id: p.id,
        name: p.displayName,
        last: recent === undefined ? null : { type: recent.fType, at: recent.eventMs, state: summary(stateOfPunch(db, recent, t)) },
      };
    });
    const queue = [];
    const sending = [];
    for (const punch of openPunches(db).filter((p) => p.branch === device.branch)) {
      const state = stateOfPunch(db, punch, t);
      const name = personById(db, punch.employeeId)?.displayName ?? '—';
      const base = { punchId: punch.id, name, type: punch.fType, at: punch.eventMs };
      if (state.kind === 'needs-human') {
        queue.push({ ...base, why: state.why, canFileLate: state.canFileLate, problem: problemView(state.lastProblem) });
      } else if (state.kind === 'sending' || state.kind === 'sending-late') {
        sending.push({
          ...base,
          late: state.kind === 'sending-late',
          overdue: state.kind === 'sending' ? state.overdue : true,
          untilMs: state.untilMs,
          attempts: state.attempts,
          problem: problemView(state.lastProblem),
        });
      }
    }
    const pass = hooks.outbox.lastPassMs;
    return {
      now: t,
      label: page.heading,
      inspectorateEmail: page.inspectorateEmail ?? null,
      healthy: pass !== undefined && t - pass < HEALTHY_PASS_MS,
      staff: people,
      queue,
      sending,
      warnings: hooks.warnings?.(t) ?? [],
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/health') {
      const pass = hooks.outbox.lastPassMs;
      const ok = pass !== undefined && now() - pass < HEALTHY_PASS_MS;
      return send(res, ok ? 200 : 503, ok ? 'ok' : 'stale', 'text/plain; charset=utf-8');
    }
    if (method === 'GET' && path === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8');
    if (method === 'GET' && path === '/app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8');
    if (method === 'GET' && path === '/odontia-mark.svg') return send(res, 200, ODONTIA_MARK, 'image/svg+xml');

    const enroll = /^\/enroll\/([A-Za-z0-9_-]{20,100})$/.exec(path);
    if (method === 'GET' && enroll !== null) {
      const token = redeemEnrollment(db, enroll[1] ?? '', now());
      if (token === undefined) return send(res, 404, notEnrolledPage('Ο σύνδεσμος εγγραφής δεν ισχύει (έληξε ή χρησιμοποιήθηκε).'), 'text/html; charset=utf-8');
      log('server: a device was enrolled');
      res.setHeader('set-cookie', cookieFor(token));
      res.setHeader('location', '/');
      return send(res, 303, '', 'text/plain; charset=utf-8');
    }

    const seen = deviceOf(req);
    const device = seen?.device;
    if (device !== undefined && branchRetired(db, device.branch)) {
      const text = 'Το παράρτημα έχει αποσυρθεί και δεν δέχεται νέες κάρτες. Ενημερώστε τον εργοδότη.';
      if (path.startsWith('/api/')) return sendJson(res, 403, { error: 'retired', text });
      return send(res, 403, notEnrolledPage(text), 'text/html; charset=utf-8');
    }
    if (seen !== undefined && now() - (cookieSent.get(seen.device.id) ?? -Infinity) >= COOKIE_REFRESH_MS) {
      cookieSent.set(seen.device.id, now());
      res.setHeader('set-cookie', cookieFor(seen.token));
    }
    if (method === 'GET' && path === '/') {
      if (device === undefined) {
        return send(res, 403, notEnrolledPage('Αυτή η συσκευή δεν είναι εγγεγραμμένη για την κάρτα εργασίας.'), 'text/html; charset=utf-8');
      }
      return send(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
    }
    if (!path.startsWith('/api/')) return sendJson(res, 404, { error: 'not-found' });
    if (device === undefined) return sendJson(res, 403, { error: 'device' });

    if (method === 'GET' && path === '/api/board') return sendJson(res, 200, board(device));
    const card = /^\/api\/card\/(\d{1,12})$/.exec(path);
    if (method === 'GET' && card !== null) {
      const punch = cardOf(device, Number(card[1]));
      if (punch === undefined) return sendJson(res, 404, { error: 'not-found' });
      return sendJson(res, 200, { state: summary(stateOfPunch(db, punch, now())) });
    }

    if (method !== 'POST') return sendJson(res, 405, { error: 'method' });
    assertSameOrigin(req);
    const body = await readJson(req);

    if (path === '/api/pin') {
      const input = parse(PinBody, body);
      const check = await checkPin(db, input.employeeId, input.pin, now());
      if (check.kind !== 'ok') throw pinAnswer(check);
      return sendJson(res, 200, afterPin(check.person, device, check.mustChooseOwn));
    }
    if (path === '/api/own-pin') {
      const input = parse(OwnPinBody, body);
      const ticket = takeTicket(input.ticket, device, 'choose');
      const chosen = await chooseOwnPin(db, ticket.person, input.newPin, now());
      if (!chosen.ok) {
        // The same ticket, again: the person tries another PIN without starting over.
        tickets.set(input.ticket, ticket);
        throw new HttpError(422, { error: 'pin-refused', text: chosen.problem });
      }
      return sendJson(res, 200, afterPin(chosen.person, device, false));
    }
    if (path === '/api/history') {
      const input = parse(HistoryBody, body);
      // Identity comes only from a PIN-checked, device-bound ticket, never an employee id supplied by the browser.
      // Reading consumes the stamp capability; later pages carry a history-only ticket and cannot create a card.
      const stage = tickets.get(input.ticket)?.stage === 'history' ? 'history' : 'stamp';
      const ticket = takeTicket(input.ticket, device, stage);
      const history = ownHistoryOf(db, ticket.person, input.from, input.to, input.before, now(),
        (code) => options.branches.length > 1 ? options.branches.find((b) => b.code === code)?.heading ?? code : '');
      return sendJson(res, 200, {
        ...history, name: ticket.person.displayName, from: input.from, to: input.to,
        ticket: newTicket(ticket.person, device.id, 'history', null),
      });
    }
    if (path === '/api/stamp') {
      const input = parse(StampBody, body);
      const ticket = takeTicket(input.ticket, device, 'stamp');
      // ⚠ Her screen shows her last card as it was when she typed her PIN, and asks «again?» against it (page.ts,
      // `confirmCard`). A card of hers made since — on the other enrolled device, in a second tab — makes that screen
      // stale: two screens opened before her arrival would otherwise file two different ΕΝΑΡΞΗ for it, the second with
      // no warning. Refused, the ticket spent: she starts again and sees the card; a repeat she
      // means is still hers to confirm. ⓘ No await between this look and the INSERT, so no other request runs between.
      if ((lastPunchOf(db, ticket.person.employeeId)?.id ?? null) !== ticket.lastPunchId) {
        throw new HttpError(409, {
          error: 'stale',
          text: 'Στο μεταξύ καταχωρήθηκε άλλη κίνησή σας, σε άλλη οθόνη. Ξεκινήστε πάλι από το όνομά σας για να τη δείτε.',
        });
      }
      // ⛔⛔ Durable before dispatch: committed here, THEN the outbox is woken (docs/RULES.md rule 2).
      const punch = capturePunch(db, ticket.person, input.type, device, now());
      log(`server: card ${punch.id} captured`);
      hooks.outbox.wake();
      return sendJson(res, 200, { ok: true, punchId: punch.id, at: punch.eventMs, referenceDate: punch.referenceDate });
    }
    if (path === '/api/decide') {
      const input = parse(DecideBody, body);
      if (input.kind === 'file_late' && input.reason === undefined) {
        throw new HttpError(422, { error: 'reason', text: 'Διαλέξτε αιτία.' });
      }
      // A card of another branch is decided at that branch's page, which shows it in its queue. Asked before the PIN,
      // so a refused question costs no PIN try.
      if (cardOf(device, input.punchId) === undefined) {
        throw new HttpError(409, { error: 'decision', text: 'Αυτή η κάρτα δεν είναι αυτού του παραρτήματος.' });
      }
      const check = await checkPin(db, input.employeeId, input.pin, now());
      if (check.kind !== 'ok') throw pinAnswer(check);
      if (check.mustChooseOwn) {
        throw new HttpError(403, { error: 'own-pin', text: 'Πρώτα διαλέξτε δικό σας κωδικό (πατήστε το όνομά σας στην αρχική).' });
      }
      try {
        decide(
          db,
          input.punchId,
          input.kind === 'file_late' && input.reason !== undefined ? { kind: 'file_late', fAitiologia: input.reason } : { kind: 'covered' },
          { employeeId: check.person.employeeId, label: check.person.displayName, deviceId: device.id },
          now(),
        );
      } catch (error) {
        throw new HttpError(409, { error: 'decision', text: error instanceof Error ? error.message : 'Δεν έγινε.' });
      }
      log(`server: decision on card ${input.punchId} (${input.kind})`);
      hooks.outbox.wake();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'not-found' });
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, error.body);
      log(`server: ${req.method ?? ''} ${(req.url ?? '').split('?')[0]?.replace(/\/enroll\/.*/, '/enroll/…')} failed — ${error instanceof Error ? error.name : 'error'}`);
      return sendJson(res, 500, { error: 'server', text: 'Κάτι πήγε στραβά. Δοκιμάστε ξανά — αν συνεχίσει, CardScanner.' });
    });
  });
}

/** The card state, as the page needs it. */
function summary(state: CardState) {
  switch (state.kind) {
    case 'filed':
      return { kind: state.kind, protocol: state.protocol, late: state.late };
    case 'covered':
      return { kind: state.kind };
    case 'sending':
      return { kind: state.kind, overdue: state.overdue, untilMs: state.untilMs, problem: problemView(state.lastProblem) };
    case 'sending-late':
      return { kind: state.kind, untilMs: state.untilMs, problem: problemView(state.lastProblem) };
    case 'needs-human':
      return { kind: state.kind, why: state.why };
  }
}

/**
 * ΕΡΓΑΝΗ's sentence for the page. ⛔ The reception screen is seen by anyone at the desk, patients included, and a
 * ministry sentence may quote the employee's ΑΦΜ: nine digits in a row are blanked here, as on the phone (`withoutAfm`).
 * The sentence stays verbatim in the record (`attempts.message`, rule 8).
 */
function problemView(problem: Problem | undefined) {
  return problem === undefined
    ? null
    : { refused: problem.outcome === 'refused', status: problem.httpStatus ?? null, message: withoutAfm(problem.message) };
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
};

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

/** POSTs come from this page: JSON, with an `Origin` naming the host the request was sent to. */
function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json') || origin === undefined || host === undefined) {
    throw new HttpError(403, { error: 'origin' });
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, { error: 'origin' });
  }
  if (originHost !== host) throw new HttpError(403, { error: 'origin' });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, { error: 'too-big' });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, { error: 'json' });
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, { error: 'input' });
  return result.data;
}
