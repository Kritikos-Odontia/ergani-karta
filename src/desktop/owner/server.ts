// SPDX-License-Identifier: EUPL-1.2
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { settingsFile } from '../../setup/settings.js';
import { newEasyTopic } from '../../stamp/notify.js';
import type { DesktopPaths } from '../paths.js';
import { readDesktopState, writeDesktopState, type DesktopState } from '../state.js';
import { restoreBackup } from '../backup.js';
import { OwnerSessions, hashPassword, sameToken } from './auth.js';
import { OWNER_CSS, html, note, page, type Html } from './html.js';
import { privateAddresses, readSetupForm, setupPage, setupProblems, type SetupForm } from './setup-page.js';

/**
 * THE OWNER'S SERVER — the setup on first run, then the owner's pages. ⛔ 127.0.0.1 only.
 *
 * Every request is judged here before any page sees it:
 *   · the Host header must name this server (`127.0.0.1:<port>` or `localhost:<port>`) — a page elsewhere on the
 *     internet cannot reach it through a name it points at this computer (DNS rebinding);
 *   · a POST must come from this server's own pages (Origin), as a form, small, and — once signed in — carry the
 *     session's CSRF token;
 *   · after setup, every page but sign-in needs the owner's session (auth.ts).
 * The pages send no script; the CSP allows none.
 */
export interface OwnerPage {
  /** `GET` renders; `POST` acts and answers with a page or a redirect. The form is already CSRF-checked. */
  (request: { method: 'GET' | 'POST'; path: string; query: URLSearchParams; form: URLSearchParams; csrf: string }):
    | Promise<{ status?: number; body: string } | { redirect: string }>
    | { status?: number; body: string }
    | { redirect: string };
}

export interface OwnerOptions {
  paths: DesktopPaths;
  now: () => number;
  log: (line: string) => void;
  /** After the setup is saved (settings + owner password written): make the stores and start the services. */
  onSetup: () => Promise<void>;
  /** The signed-in pages, by path (home included), once the services run; `undefined` while they start. */
  pages: () => ReadonlyMap<string, OwnerPage> | undefined;
  /** The «ΕΡΓΑΝΗ user step by step» guide (served without sign-in: it holds nothing of the practice). */
  guide: string;
  mark: string;
}

const COOKIE = 'karta_owner';
const MAX_BODY = 64 * 1024;
const HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  // same-origin, not no-referrer: with no-referrer, Chrome and Edge send «Origin: null» on these forms, and the
  // Origin check below refuses them all. Links out (the maker's site, ntfy.sh) still carry no referrer.
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
} as const;

export function createOwnerServer(o: OwnerOptions): Server {
  const sessions = new OwnerSessions(o.now);
  let restoreFailures = 0;
  let restoreLockedUntil = 0;
  const todayMonth = () => new Date(o.now()).toISOString().slice(0, 7);

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, 'content-type': type, ...extra });
    res.end(body);
  };
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string> = {}) => {
    res.writeHead(303, { ...HEADERS, location: to, ...extra });
    res.end();
  };
  const cookieOf = (req: IncomingMessage) =>
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

  async function formOf(req: IncomingMessage): Promise<URLSearchParams | undefined> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return undefined;
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ⛔ Only this server's own names, on the port the request came in on (DNS rebinding).
    const port = req.socket.localPort;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(req.headers.host ?? '')) return send(res, 421, 'Misdirected request', 'text/plain; charset=utf-8');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method === 'POST' ? 'POST' : req.method === 'GET' || req.method === 'HEAD' ? 'GET' : undefined;
    if (method === undefined) return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    if (url.pathname === '/owner.css') return send(res, 200, OWNER_CSS, 'text/css; charset=utf-8');
    if (url.pathname === '/odontia-mark.svg') return send(res, 200, o.mark, 'image/svg+xml');
    if (url.pathname === '/odigos') return send(res, 200, o.guide);

    let form = new URLSearchParams();
    if (method === 'POST') {
      // ⛔ A POST only from these pages, as a form.
      if (![...hosts].some((h) => req.headers.origin === `http://${h}`)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      const read = await formOf(req);
      if (read === undefined) return send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
      form = read;
    }

    // ── First run: only the setup answers, until it is saved ────────────────────────────────────────
    const state = readDesktopState(o.paths.desktop);
    if (state === undefined || (!existsSync(o.paths.settings) && state.recovery === undefined)) {
      if (url.pathname === '/restore') {
        if (method === 'GET') return send(res, 200, restorePage());
        if (o.now() < restoreLockedUntil) return send(res, 429, restorePage(note('bad', 'Πολλοί λάθος κωδικοί. Ξαναδοκιμάστε σε 10 λεπτά.')));
        try {
          restoreBackup(o.paths, form.get('folder') ?? '', form.get('password') ?? '', o.now());
          restoreFailures = 0;
        } catch {
          if (++restoreFailures >= 5) { restoreLockedUntil = o.now() + 10 * 60_000; restoreFailures = 0; }
          return send(res, 400, restorePage(note('bad', 'Δεν έγινε επαναφορά. Ελέγξτε τον κωδικό εργοδότη, το πλήρες αντίγραφο και ότι ο φάκελος δεδομένων είναι άδειος.')));
        }
        await o.onSetup();
        return redirect(res, '/login');
      }
      if (url.pathname !== '/setup') return redirect(res, '/setup');
      if (method === 'GET') return send(res, 200, setupPage(todayMonth(), privateAddresses()));
      const filled = readSetupForm(form, todayMonth());
      if (form.get('more') === '1') {
        return send(res, 200, setupPage(todayMonth(), privateAddresses(), { ...filled, rows: filled.rows + 1 }));
      }
      const problems = setupProblems(filled);
      if (problems.length > 0) return send(res, 200, setupPage(todayMonth(), privateAddresses(), filled, problems));
      saveSetup(o.paths, filled, new Date(o.now()).toISOString());
      o.log('setup saved — making the stores and starting');
      try {
        await o.onSetup();
      } catch (error) {
        o.log(`start after setup failed — ${error instanceof Error ? error.message : String(error)}`);
        return send(res, 500, page('Δεν ξεκίνησε', note('bad', 'Οι ρυθμίσεις αποθηκεύτηκαν, αλλά το πρόγραμμα δεν ξεκίνησε. Κλείστε και ανοίξτε το ξανά· αν επιμένει, δείτε το αρχείο καταγραφής.'), { nav: false }));
      }
      return redirect(res, '/login');
    }

    // ── Sign-in ─────────────────────────────────────────────────────────────────────────────────────
    if (url.pathname === '/login') {
      if (method === 'GET') return send(res, 200, loginPage());
      const result = sessions.signIn(form.get('password') ?? '', state.ownerPassword);
      if (result.kind === 'ok') {
        return redirect(res, '/', { 'set-cookie': `${COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Strict` });
      }
      if (result.kind === 'locked') {
        const minutes = Math.ceil((result.untilMs - o.now()) / 60_000);
        return send(res, 429, loginPage(note('bad', `Πολλοί λάθος κωδικοί. Ξαναδοκιμάστε σε ${minutes} λεπτά.`)));
      }
      return send(res, 401, loginPage(note('bad', 'Λάθος κωδικός.')));
    }
    const token = cookieOf(req);
    const csrf = sessions.touch(token, state.ownerPassword);
    if (csrf === undefined) return redirect(res, '/login');
    if (method === 'POST' && !sameToken(form.get('csrf') ?? '', csrf)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    if (url.pathname === '/logout' && method === 'POST') {
      sessions.signOut(token);
      return redirect(res, '/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }

    const pages = o.pages();
    if (pages === undefined) return send(res, 503, page('Ξεκινά…', note('warn', 'Το πρόγραμμα ξεκινά. Ανανεώστε τη σελίδα σε λίγα δευτερόλεπτα.'), { csrf }));
    const handler = pages.get(url.pathname);
    if (handler === undefined) return send(res, 404, page('Δεν υπάρχει', html`<p><a href="/">Αρχική</a></p>`, { csrf }));
    const answer = await handler({ method, path: url.pathname, query: url.searchParams, form, csrf });
    if ('redirect' in answer) return redirect(res, answer.redirect);
    return send(res, answer.status ?? 200, answer.body);
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      o.log(`owner page failed — ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, page('Σφάλμα', note('bad', 'Κάτι πήγε στραβά. Δοκιμάστε ξανά.'), { nav: false }));
      else res.end();
    });
  });
}

function restorePage(message: Html = html``): string {
  return page('Επαναφορά σε νέο υπολογιστή', html`${message}
<p>Επιλέξτε το πλήρες αντίγραφο <code>karta-…</code>. Χρειάζεται ο κωδικός εργοδότη που είχατε όταν γράφτηκε. Η αποστολή μένει σταματημένη μέχρι τον έλεγχο των παλιών εκκρεμοτήτων.</p>
<form method="post" action="/restore"><label for="folder">Πλήρης διαδρομή φακέλου αντιγράφου</label><input type="text" id="folder" name="folder"><label for="password">Κωδικός εργοδότη αυτού του αντιγράφου</label><input type="password" id="password" name="password" autocomplete="current-password"><p><button>Επαναφορά</button></p></form><p><a href="/setup">Πίσω στη ρύθμιση</a></p>`, { nav: false });
}

function loginPage(message: Html = html``): string {
  return page(
    'Σύνδεση εργοδότη',
    html`${message}<form method="post" action="/login"><label for="password">Κωδικός του εργοδότη</label>
<input type="password" id="password" name="password" autocomplete="current-password" autofocus>
<p><button>Σύνδεση</button></p></form>`,
    { nav: false },
  );
}

/** Write the settings (the same file `ergani setup` writes) and the owner's password hash — both 0600. */
export function saveSetup(paths: DesktopPaths, form: SetupForm, nowIso: string): void {
  mkdirSync(dirname(paths.settings), { recursive: true, mode: 0o700 });
  writeFileSync(paths.settings, settingsFile(form.answers, nowIso), { mode: 0o600 });
  const state: DesktopState = {
    ownerPassword: hashPassword(form.ownerPassword),
    nightUpdates: true,
    ...(form.alerts ? { alerts: { topic: newEasyTopic() } } : {}),
  };
  writeDesktopState(paths.desktop, state);
}

