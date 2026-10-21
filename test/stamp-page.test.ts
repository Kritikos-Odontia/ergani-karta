// SPDX-License-Identifier: EUPL-1.2
import { Script, createContext } from 'node:vm';
import { expect, it } from 'vitest';
import { APP_JS } from '../src/stamp/page.js';

/**
 * THE RECEPTION PAGE'S OWN SCRIPT — run in `node:vm` against a minimal DOM, with a `fetch` whose answers the test holds
 * back and releases. ⛔ No network at all: nothing here leaves the process. Fabricated names only.
 *
 * Why the page has a test of its own: its fences protect docs/RULES.md rule 1 at the screen — the answer to one person's
 * step lands only on that person's screen, so a departed person's live ticket can never reach the next person — and
 * «never silent» on the one step that writes a card.
 */

class Element_ {
  children: Element_[] = [];
  text = '';
  attrs: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public tag: string) {}
  append(...kids: unknown[]) {
    for (const k of kids) this.children.push(typeof k === 'string' ? Object.assign(new Element_('#text'), { text: k }) : (k as Element_));
  }
  replaceChildren(...kids: unknown[]) {
    this.children = [];
    this.append(...kids);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: (e: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  set textContent(v: string) {
    this.children = [Object.assign(new Element_('#text'), { text: v })];
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join('');
  }
  all(): Element_[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  click() {
    for (const f of this.listeners['click'] ?? []) f({});
  }
}

interface Held {
  path: string;
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
}

function bootPage(boardExtra: Record<string, unknown> = {}) {
  const byId: Record<string, Element_> = {};
  for (const id of ['label', 'clock', 'down', 'alerts', 'staff', 'flow', 'panel']) byId[id] = new Element_('div');
  const keys: Array<(e: { key: string }) => void> = [];
  const held: Held[] = [];
  const board = {
    now: 0,
    label: 'Δοκιμή',
    inspectorateEmail: null,
    healthy: true,
    staff: [
      { id: 1, name: 'Πρώτη', last: null },
      { id: 2, name: 'Δεύτερη', last: null },
    ],
    queue: [],
    sending: [],
    warnings: [],
    ...boardExtra,
  };
  const context = createContext({
    document: {
      getElementById: (id: string) => byId[id],
      createElement: (tag: string) => new Element_(tag),
      addEventListener: (type: string, f: (e: { key: string }) => void) => {
        if (type === 'keydown') keys.push(f);
      },
      querySelector: () => null,
    },
    window: {},
    location: { reload: () => undefined },
    AbortSignal: { timeout: () => undefined },
    // Short timers run (the PIN pad's repaint); the page's long ones (idle, result screens) are not this test's subject.
    setTimeout: (f: () => void, ms: number) => (ms >= 1000 ? 0 : setTimeout(f, ms)),
    clearTimeout: () => undefined,
    setInterval: () => 0,
    Date,
    Promise,
    fetch: (path: string) => {
      if (path === '/api/board') return Promise.resolve({ status: 200, json: async () => board });
      return new Promise((resolve, reject) => held.push({ path, resolve, reject }));
    },
  });
  new Script(APP_JS).runInContext(context);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const button = (text: string) =>
    byId['staff']!.all()
      .concat(byId['panel']!.all(), byId['alerts']!.all())
      .find((n) => n.tag === 'button' && n.textContent.startsWith(text))!;
  const type = (digits: string) => {
    for (const d of digits) for (const f of keys) f({ key: d });
  };
  const heading = () => byId['panel']!.all().find((n) => n.tag === 'h2')?.textContent;
  const error = () => byId['panel']!.all().find((n) => n.className === 'error')?.textContent;
  const answer = (h: Held, data: unknown) => h.resolve({ status: 200, json: async () => data });
  return { byId, held, settle, button, type, heading, error, answer };
}

const session = (name: string, ticket: string) => ({ ok: true, ticket, mustChooseOwn: false, name, suggestion: '0', last: null });

it('a late answer to one person\'s PIN never lands on the next person\'s screen (rule 1)', async () => {
  const page = bootPage();
  await page.settle();
  page.button('Πρώτη').click();
  page.type('2580');
  expect(page.held.map((h) => h.path)).toEqual(['/api/pin']);
  page.button('Άκυρο').click(); // she walks away; her answer is still on its way
  page.button('Δεύτερη').click(); // the next person's PIN pad
  expect(page.heading()).toBe('Δεύτερη');
  page.answer(page.held[0]!, session('Πρώτη', 'TICKET-OF-PROTI'));
  await page.settle();
  // Still HER pad — not Πρώτη's ΕΝΑΡΞΗ/ΛΗΞΗ screen holding Πρώτη's live ticket.
  expect(page.heading()).toBe('Δεύτερη');
  expect(page.byId['panel']!.all().some((n) => n.textContent.startsWith('ΕΝΑΡΞΗ (Προσέλευση)'))).toBe(false);
});

it('«Επιβεβαίωση» sends once however often it is tapped, and a send lost in transit is said, never silent', async () => {
  const page = bootPage();
  await page.settle();
  page.button('Δεύτερη').click();
  page.type('1397');
  page.answer(page.held[0]!, session('Δεύτερη', 'T2'));
  await page.settle();
  page.button('ΕΝΑΡΞΗ').click();
  page.button('Επιβεβαίωση').click();
  page.button('Επιβεβαίωση').click();
  expect(page.held.filter((h) => h.path === '/api/stamp')).toHaveLength(1);
  page.held.at(-1)!.reject(new TypeError('Failed to fetch'));
  await page.settle();
  expect(page.heading()).toBe('Δεν ξέρω αν καταχωρήθηκε');
});

it('a PIN request lost in transit is said on the pad — never swallowed', async () => {
  const page = bootPage();
  await page.settle();
  page.button('Πρώτη').click();
  page.type('2580');
  page.held[0]!.reject(new TypeError('Failed to fetch'));
  await page.settle();
  expect(page.heading()).toBe('Πρώτη');
  expect(page.error()).toMatch(/^Ο server δεν απαντά.*CardScanner/);
});

// 04/10/2026 09:00 Athens (UTC+3): a card that waited in the queue overnight.
const AT = Date.UTC(2026, 9, 4, 6, 0);
const wallEntry = { punchId: 7, name: 'Πρώτη', type: '0', at: AT, why: 'wall', canFileLate: true, problem: null };

it('the queue says, on screen and on «Τι κάνω;», that the employer owes BOTH notifications to the Επιθεώρηση (rule 5)', async () => {
  const page = bootPage({ now: AT + 16 * 60_000, queue: [wallEntry], inspectorateEmail: 'epitheorisi@example.invalid' });
  await page.settle();
  const both = /μία φορά όταν αρχίζει το πρόβλημα και ΞΑΝΑ όταν τελειώνει/;
  expect(page.byId['alerts']!.textContent).toMatch(both);
  expect(page.byId['alerts']!.textContent).toContain('με email στο epitheorisi@example.invalid');
  page.button('Τι κάνω;').click();
  expect(page.byId['panel']!.textContent).toMatch(both);
  expect(page.byId['panel']!.textContent).toContain('ΔΕΝ αντικαθιστά αυτά τα δύο μηνύματα');
});

it('a queue entry names its DAY — and at the 14-minute stop says when it becomes late, «late» only after 15', async () => {
  const early = bootPage({ now: AT + 14.5 * 60_000, queue: [wallEntry] });
  await early.settle();
  const before = early.byId['alerts']!.textContent;
  expect(before).toContain('04/10, 09:00');
  expect(before).toContain('ΔΕΝ στάλθηκε, και δεν θα σταλεί πια αυτόματα — στις 09:15 γίνεται εκπρόθεσμη.');
  expect(before).not.toContain('ΔΕΝ στάλθηκε μέσα στα 15 λεπτά');
  // Never «stamp again» for a card the page holds (docs/DECISIONS.md, «One arrival, one card»).
  expect(before).not.toContain('CardScanner');
  early.button('Τι κάνω;').click();
  expect(early.heading()).toContain('04/10, 09:00');

  const late = bootPage({ now: AT + 16 * 60_000, queue: [wallEntry] });
  await late.settle();
  expect(late.byId['alerts']!.textContent).toContain('ΔΕΝ στάλθηκε μέσα στα 15 λεπτά — είναι εκπρόθεσμη.');
});

it('a card still on its way is never a prompt to stamp again on CardScanner — not at 5 minutes either', async () => {
  const sending = { punchId: 8, name: 'Πρώτη', type: '0', at: AT, late: false, overdue: true, untilMs: AT + 14 * 60_000, attempts: 3, problem: null };
  const page = bootPage({ now: AT + 6 * 60_000, sending: [sending] });
  await page.settle();
  const text = page.byId['alerts']!.textContent;
  expect(text).toContain('δεν έχει φτάσει ακόμη στην ΕΡΓΑΝΗ. Ξαναδοκιμάζω ως τις 09:14.');
  expect(text).not.toContain('CardScanner');
});

it('«sending is slow or has stopped» never sends staff to CardScanner while the page still takes stamps', async () => {
  // The outbox can read as stopped while one attempt works through a slow ΕΡΓΑΝΗ — with her card on the board.
  const sending = { punchId: 9, name: 'Πρώτη', type: '0', at: AT, late: false, overdue: true, untilMs: AT + 14 * 60_000, attempts: 2, problem: null };
  const page = bootPage({ now: AT + 6 * 60_000, healthy: false, sending: [sending] });
  await page.settle();
  const text = page.byId['alerts']!.textContent;
  expect(text).toContain('Η αποστολή στην ΕΡΓΑΝΗ καθυστερεί ή έχει σταματήσει.');
  expect(text).toContain('μην το ξαναχτυπήσετε');
  expect(text).not.toContain('CardScanner');
});

/**
 * The board and «the server is not answering», against a page clock the test moves and timers it fires by hand — as a
 * browser fires a HIDDEN tab's timers: once a minute. The speaker counts its beeps. ⛔ No network.
 */
function bootBoard() {
  const byId: Record<string, Element_> = {};
  for (const id of ['label', 'clock', 'down', 'alerts', 'staff', 'flow', 'panel']) byId[id] = new Element_('div');
  let clock = Date.parse('2026-10-05T09:00:00+03:00');
  const intervals: Array<() => void> = [];
  const shown: Array<() => void> = [];
  const doc = { hidden: true };
  const reads: string[] = [];
  let server: 'answers' | 'fails' | 'hangs' = 'answers';
  let beeps = 0;
  class PageDate extends Date {
    static override now() {
      return clock;
    }
  }
  const node = { connect: () => undefined, start: () => void (beeps += 1), stop: () => undefined, frequency: {}, gain: {} };
  const context = createContext({
    document: {
      getElementById: (id: string) => byId[id],
      createElement: (tag: string) => new Element_(tag),
      addEventListener: (type: string, f: () => void) => {
        if (type === 'visibilitychange') shown.push(f);
      },
      querySelector: () => null,
      get hidden() {
        return doc.hidden;
      },
    },
    window: { AudioContext: class { currentTime = 0; destination = {}; createOscillator = () => node; createGain = () => node; } },
    location: { reload: () => undefined },
    AbortSignal: { timeout: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: (f: () => void) => intervals.push(f),
    Date: PageDate,
    Promise,
    fetch: (path: string) => {
      reads.push(path);
      if (server === 'fails') return Promise.reject(new Error('connection refused'));
      if (server === 'hangs') return new Promise(() => {});
      return Promise.resolve({ status: 200, json: async () => ({ now: clock, label: 'Δοκιμή', inspectorateEmail: null, healthy: true, staff: [{ id: 1, name: 'Πρώτη', last: null }], queue: [], sending: [], warnings: [] }) });
    },
  });
  new Script(APP_JS).runInContext(context);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    beeps: () => beeps,
    isDown: () => !byId['down']!.hidden,
    reads,
    serverNow: (mode: typeof server) => void (server = mode),
    /** `ms` pass, then every timer fires ONCE — the clock-and-watchdog tick first, then the board read. */
    async after(ms: number) {
      clock += ms;
      for (const f of intervals) f();
      await settle();
    },
    async show() {
      doc.hidden = false;
      for (const f of shown) f();
      await settle();
    },
    settle,
  };
}

it('a hidden tab whose timers run once a minute never beeps while the server answers every read', async () => {
  const page = bootBoard();
  await page.settle();
  for (let minute = 0; minute < 10; minute += 1) await page.after(60_000);
  expect(page.reads.length).toBeGreaterThanOrEqual(11);
  expect(page.isDown()).toBe(false);
  expect(page.beeps()).toBe(0);
});

it('a real outage still turns the page red and beeps once — hidden or shown — and a good read clears it', async () => {
  const hidden = bootBoard();
  await hidden.settle();
  hidden.serverNow('fails');
  await hidden.after(60_000);
  // One failed read is not yet «not answering»: the next one, a minute on, still failing, is.
  expect(hidden.isDown()).toBe(false);
  await hidden.after(60_000);
  expect(hidden.isDown()).toBe(true);
  await hidden.after(60_000);
  expect(hidden.beeps()).toBe(1);
  hidden.serverNow('answers');
  await hidden.after(60_000);
  expect(hidden.isDown()).toBe(false);

  // Shown, reading every 5 s: red once the reads have failed for 30 s, not before.
  const shown = bootBoard();
  await shown.show();
  shown.serverNow('fails');
  for (let s = 5; s < 30; s += 5) await shown.after(5_000);
  expect(shown.isDown()).toBe(false);
  await shown.after(5_000);
  await shown.after(5_000);
  expect(shown.isDown()).toBe(true);
  expect(shown.beeps()).toBe(1);
});

it('a single failed read in a hidden tab, then a good one a minute later, is no outage', async () => {
  const page = bootBoard();
  await page.settle();
  page.serverNow('fails');
  await page.after(60_000);
  page.serverNow('answers');
  await page.after(60_000);
  await page.after(60_000);
  expect(page.isDown()).toBe(false);
  expect(page.beeps()).toBe(0);
});

it('a read that never answers turns the page red after 30 s on its way — one read at a time', async () => {
  const page = bootBoard();
  await page.show();
  page.serverNow('hangs');
  await page.after(5_000); // this read goes out, and never answers
  const sent = page.reads.length;
  for (let s = 1; s < 30; s += 1) await page.after(1_000);
  expect(page.isDown()).toBe(false);
  expect(page.reads.length).toBe(sent);
  await page.after(1_000);
  expect(page.isDown()).toBe(true);
  expect(page.beeps()).toBe(1);
});

it('reads the board again the moment the tab is shown', async () => {
  const page = bootBoard();
  await page.settle();
  const before = page.reads.length;
  await page.show();
  expect(page.reads.length).toBe(before + 1);
});
