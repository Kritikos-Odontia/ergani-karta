// SPDX-License-Identifier: EUPL-1.2
/**
 * THE RECEPTION PAGE — one HTML page, one stylesheet, one script; no framework, no outside asset (the CSP allows only
 * this server). Greek, large targets, readable across a desk.
 *
 * ⓘ Every piece of data is put on screen with `textContent`, never as HTML, so a name or a ministry sentence can
 * never become markup. The page holds no data of its own: it asks the server every 5 seconds, and if the server stops
 * answering it turns red and tells the staff to use CardScanner.
 */

/** The maker's label at the foot of every screen: the maker's mark (src/brand/, not under the EUPL — NOTICE) and a line. */
export const MADE_BY = '<footer class="made-by"><img src="/odontia-mark.svg" alt="" width="18" height="18">Φτιαγμένο από την Odontia</footer>';

export const PAGE_HTML = `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Κάρτα Εργασίας</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1 id="label">Κάρτα Εργασίας</h1><div id="clock"></div></header>
<div id="down" hidden>
  <strong>Η σελίδα δεν μιλά με τον server.</strong>
  Μέχρι να φύγει αυτό το μήνυμα: <strong>χτυπήστε κάρτα με το CardScanner</strong>, και ενημερώστε τον εργοδότη.
</div>
<section id="alerts"></section>
<main>
  <p class="hint">Πατήστε το όνομά σας για να χτυπήσετε κάρτα.</p>
  <div id="staff" class="grid"></div>
</main>
<div id="flow" hidden><div id="panel"></div></div>
${MADE_BY}
<script src="/app.js"></script>
</body>
</html>
`;

export function notEnrolledPage(text: string): string {
  const safe = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Κάρτα Εργασίας</title>
<link rel="stylesheet" href="/app.css"></head><body><main><p class="notice">${safe}</p>
<p class="hint">Για να χτυπήσετε κάρτα τώρα: CardScanner.</p></main>${MADE_BY}</body></html>`;
}

export const APP_CSS = `
:root { --red: #b3261e; --amber: #b26a00; --green: #1e7b34; --ink: #1b1b1b; --soft: #f2f2f2; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; font-size: 22px; }
.made-by { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 16px; font-size: 14px; color: #666; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--soft); }
h1 { font-size: 28px; margin: 0; }
#clock { font-size: 28px; font-variant-numeric: tabular-nums; }
main { padding: 16px 24px; }
.hint { color: #555; }
.notice { font-size: 26px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.person { border: 2px solid #ccc; border-radius: 14px; padding: 22px; text-align: left; background: #fff; cursor: pointer; font-size: 30px; min-height: 120px; }
.person:active { background: var(--soft); }
.person small { display: block; font-size: 19px; color: #555; margin-top: 8px; }
.person.in { border-color: var(--green); }
.person.problem { border-color: var(--red); }
#down { background: var(--red); color: #fff; padding: 24px; font-size: 28px; }
#alerts .alert { margin: 12px 24px; padding: 16px 20px; border-radius: 12px; border: 3px solid; }
#alerts .red { border-color: var(--red); background: #fdecea; }
#alerts .amber { border-color: var(--amber); background: #fff4e0; }
#alerts .duty { margin: 12px 24px; padding: 16px 20px; background: #fdecea; border-left: 8px solid var(--red); }
.ministry { display: block; margin-top: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 17px; white-space: pre-wrap; }
button { font: inherit; }
.big { font-size: 30px; padding: 22px 30px; border-radius: 14px; border: 2px solid #888; background: #fff; margin: 8px; cursor: pointer; min-width: 220px; }
.big.primary { background: var(--green); color: #fff; border-color: var(--green); }
.big.suggested { outline: 6px solid #7cc58f; }
.big.danger { background: var(--red); color: #fff; border-color: var(--red); }
.small { font-size: 20px; padding: 10px 16px; border-radius: 10px; border: 2px solid #888; background: #fff; cursor: pointer; margin-top: 10px; }
#flow { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
#flow[hidden] { display: none; }
#panel { background: #fff; border-radius: 18px; padding: 28px 32px; width: min(760px, 94vw); max-height: 94vh; overflow: auto; }
#panel h2 { margin-top: 0; font-size: 32px; }
.dots { font-size: 48px; letter-spacing: 18px; margin: 10px 0 18px; min-height: 60px; }
.keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.keys button { font-size: 36px; padding: 18px 0; border-radius: 12px; border: 2px solid #aaa; background: #fff; cursor: pointer; }
.error { color: var(--red); font-weight: 600; min-height: 1.4em; }
.ok { color: var(--green); font-weight: 700; font-size: 30px; }
.warn { color: var(--amber); font-weight: 600; }
.choices label { display: block; padding: 10px 0; font-size: 24px; }
.who { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
.who button.chosen { outline: 5px solid #7cc58f; }
`;

export const APP_JS = `'use strict';
(() => {
  const TYPE = { '0': 'ΕΝΑΡΞΗ', '1': 'ΛΗΞΗ' };
  const TYPE_LONG = { '0': 'ΕΝΑΡΞΗ (Προσέλευση)', '1': 'ΛΗΞΗ (Αποχώρηση)' };
  const REASONS = [
    ['001', 'Πρόβλημα στην ηλεκτροδότηση / τις τηλεπικοινωνίες'],
    ['002', 'Πρόβλημα στα συστήματα του εργοδότη'],
    ['003', 'Πρόβλημα σύνδεσης με το ΠΣ ΕΡΓΑΝΗ'],
  ];
  const IDLE_MS = 60000;
  let board = null;
  let skew = 0;
  // The board read now on its way (when it was sent), and the first read of the failing streak (when it was sent).
  let readingSince = null;
  let failingSince = null;
  const DOWN_MS = 30000;
  let seenRed = new Set();
  let idle = null;
  let flow = null;
  // Which screen is up: every show() and close() moves it on, so a timer set for one person's result screen can never
  // close the next person's PIN pad.
  let screen = 0;

  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) e.append(k);
    return e;
  }
  // 24-hour clock, Athens time — never «π.μ./μ.μ.».
  const tz = { timeZone: 'Europe/Athens', hourCycle: 'h23' };
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('el-GR', { ...tz, hour: '2-digit', minute: '2-digit' });
  // A queue entry can wait overnight: it always carries its day, so yesterday's card is never decided for today's.
  const dayHhmm = (ms) => new Date(ms).toLocaleString('el-GR', { ...tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const OFFLINE = 'Ο server δεν απαντά. Δοκιμάστε ξανά — αν συνεχίσει, χτυπήστε με το CardScanner.';
  const dayTime = (ms) => new Date(ms).toLocaleString('el-GR', { ...tz, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const serverNow = () => Date.now() + skew;

  async function api(path, body) {
    // A READ gives up after 10 s, so a hung request fails like a refused one. ⛔ Never a POST: a stamp the server did
    // write must not be reported as «not registered» because its answer was slow.
    const readLimit = window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    const init = body === undefined ? { cache: 'no-store', signal: readLimit } : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, init);
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'device') { location.reload(); throw new Error('device'); }
      return { status: res.status, data };
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // ⛔ THE ANSWER TO ONE PERSON'S STEP LANDS ONLY ON THAT PERSON'S SCREEN. Every request of the flow (PIN, own PIN,
  // card, decision) goes through here: if the screen moved on while it was answered (Άκυρο, the idle timeout, the
  // next person's name), the answer is dropped — never painted over someone else's screen, where it would hand them a
  // ticket to make a card in the first person's name (docs/RULES.md rule 1). What the server did, the board shows.
  async function flowApi(path, body) {
    const asked = screen;
    let answer;
    try {
      answer = await api(path, body);
    } catch (e) {
      if (screen !== asked) return new Promise(() => {});
      throw e;
    }
    if (screen !== asked) return new Promise(() => {});
    return answer;
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.2;
      o.connect(g); g.connect(ctx.destination);
      // One context per beep, closed when the tone ends: a browser allows only a few open at once.
      o.onended = () => { ctx.close(); };
      o.start(); o.stop(ctx.currentTime + 0.6);
    } catch (e) { /* no sound available */ }
  }

  // ── The board ─────────────────────────────────────────────────────────────────────────────────
  async function refresh() {
    if (readingSince !== null) return; // one board read at a time
    const sent = Date.now();
    readingSince = sent;
    try {
      const { status, data } = await api('/api/board');
      if (status !== 200) throw new Error('board ' + status);
      board = data;
      skew = data.now - Date.now();
      failingSince = null;
      $('down').hidden = true;
      render();
    } catch (e) {
      if (failingSince === null) failingSince = sent;
      if (Date.now() - failingSince >= DOWN_MS) down();
    } finally {
      readingSince = null;
    }
  }

  // «The server is not answering» is judged ONLY on board reads that really went out: reads failing for 30 s (judged
  // when one fails), or one read on its way for 30 s (judged every second) — so a request that hangs turns the page red
  // as surely as one that is refused. Never on «how long since the last board»: a browser runs a hidden tab's timers
  // once a minute, so that gap grows to a minute while the server answers every read, and the page would beep for
  // nothing. A board that arrives clears it; the page reads again the moment it is shown.
  function watchdog() {
    if (readingSince !== null && Date.now() - readingSince >= DOWN_MS) down();
  }

  function down() {
    if ($('down').hidden) beep();
    $('down').hidden = false;
  }

  function personState(p) {
    if (!p.last) return { text: '—', cls: '' };
    const s = p.last.state;
    const at = hhmm(p.last.at);
    const what = TYPE[p.last.type] + ' ' + at;
    if (s.kind === 'filed') return { text: what + ' ✓ ΕΡΓΑΝΗ', cls: p.last.type === '0' ? 'in' : '' };
    if (s.kind === 'covered') return { text: what + ' (καλύφθηκε)', cls: '' };
    if (s.kind === 'needs-human') return { text: what + ' — ΔΕΝ ΣΤΑΛΘΗΚΕ', cls: 'problem' };
    return { text: what + ' — στέλνεται…', cls: s.overdue ? 'problem' : '' };
  }

  function dutyBox() {
    const where = board.inspectorateEmail
      ? 'με email στο ' + board.inspectorateEmail
      : 'την οικεία Επιθεώρηση Εργασίας';
    return el('div', { class: 'duty' },
      el('strong', {}, 'Δήλωση που δεν έφτασε στην ΕΡΓΑΝΗ μέσα σε 15 λεπτά είναι ΕΚΠΡΟΘΕΣΜΗ. '),
      'Ο εργοδότης ειδοποιεί ΑΜΕΣΑ ' + where + ' — ',
      el('strong', {}, 'μία φορά όταν αρχίζει το πρόβλημα και ΞΑΝΑ όταν τελειώνει'),
      ' (βλάβη, ημέρα, ώρα, ποιοι εργαζόμενοι). Η αιτία που επιλέγετε εδώ ΔΕΝ αντικαθιστά αυτά τα δύο μηνύματα.');
  }

  function problemLine(problem) {
    if (!problem) return null;
    const head = problem.refused ? 'Η ΕΡΓΑΝΗ απάντησε: ' : 'Τελευταίο σφάλμα: ';
    return el('span', { class: 'ministry' }, head + (problem.status ? '(HTTP ' + problem.status + ') ' : '') + problem.message);
  }

  function render() {
    $('label').textContent = board.label;
    $('clock').textContent = dayTime(serverNow());
    const alerts = $('alerts');
    alerts.replaceChildren();
    const red = new Set();
    if (!board.healthy) {
      red.add('outbox');
      // ⚖ «One arrival, one card» (docs/DECISIONS.md). The server is answering, so the page still takes and keeps every
      // stamp — CardScanner is only for a page that cannot take one (it says the server is not answering). And
      // «stopped» may be a slow ΕΡΓΑΝΗ: one attempt can outlast the health window.
      alerts.append(el('div', { class: 'alert red' }, el('strong', {}, 'Η αποστολή στην ΕΡΓΑΝΗ καθυστερεί ή έχει σταματήσει. '),
        'Συνεχίστε να χτυπάτε εδώ: ό,τι χτυπάτε καταγράφεται και δεν χάνεται — μην το ξαναχτυπήσετε αλλού. Ενημερώστε τον εργοδότη.'));
    }
    if (board.queue.length > 0) alerts.append(dutyBox());
    for (const q of board.queue) {
      red.add('q' + q.punchId);
      const why = q.why === 'blocked'
        ? 'Δεν στέλνεται: μεταγενέστερη κάρτα της ίδιας μέρας έχει ήδη σταλεί, ή μπορεί να έχει φτάσει, στην ΕΡΓΑΝΗ. Ενημερώστε τον λογιστή.'
        : q.why === 'late-failed' ? 'Η εκπρόθεσμη αποστολή δεν πέρασε.'
        // The outbox stops a minute before the 15 (outbox.ts, LAST_SEND_MS): in that minute the card is NOT yet late —
        // never say «late» early. No CardScanner prompt («One arrival, one card»): a person chooses the reason here.
        : serverNow() < q.at + 15 * 60000
          ? 'ΔΕΝ στάλθηκε, και δεν θα σταλεί πια αυτόματα — στις ' + hhmm(q.at + 15 * 60000) + ' γίνεται εκπρόθεσμη. Πατήστε «Τι κάνω;».'
          : 'ΔΕΝ στάλθηκε μέσα στα 15 λεπτά — είναι εκπρόθεσμη.';
      alerts.append(el('div', { class: 'alert red' },
        el('strong', {}, q.name + ' — ' + TYPE[q.type] + ' ' + dayHhmm(q.at) + ': '), why,
        problemLine(q.problem),
        el('div', {}, el('button', { class: 'small', onclick: () => openDecide(q) }, 'Τι κάνω;'))));
    }
    for (const s of board.sending) {
      if (!s.overdue && !s.problem) continue;
      const level = s.overdue ? 'red' : 'amber';
      if (level === 'red') red.add('s' + s.punchId);
      const text = s.late
        ? 'στέλνεται εκπρόθεσμα (προσπάθεια ' + (s.attempts + 1) + ').'
        // ⚖ «One arrival, one card»: a card the page holds is never stamped a second time on CardScanner.
        : 'δεν έχει φτάσει ακόμη στην ΕΡΓΑΝΗ. Ξαναδοκιμάζω ως τις ' + hhmm(s.untilMs) + '.';
      alerts.append(el('div', { class: 'alert ' + level }, el('strong', {}, s.name + ' — ' + TYPE[s.type] + ' ' + hhmm(s.at) + ': '), text, problemLine(s.problem)));
    }
    for (const w of board.warnings || []) {
      if (w.level === 'red') red.add('w' + w.key);
      alerts.append(el('div', { class: 'alert ' + w.level }, w.text));
    }
    for (const k of red) if (!seenRed.has(k)) { beep(); break; }
    seenRed = red;

    const staff = $('staff');
    staff.replaceChildren();
    for (const p of board.staff) {
      const st = personState(p);
      staff.append(el('button', { class: 'person ' + st.cls, onclick: () => startPin(p) }, p.name, el('small', {}, st.text)));
    }
  }

  setInterval(() => { $('clock').textContent = dayTime(serverNow()); watchdog(); }, 1000);

  // ── The flow: PIN → (own PIN) → ΕΝΑΡΞΗ/ΛΗΞΗ → confirm → result ──────────────────────────────
  function show(...kids) {
    screen += 1;
    $('panel').replaceChildren(...kids.filter((k) => k !== null && k !== undefined));
    $('flow').hidden = false;
    touch();
  }
  function close() {
    screen += 1;
    $('flow').hidden = true;
    $('panel').replaceChildren();
    flow = null;
    clearTimeout(idle);
  }
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(close, IDLE_MS);
  }

  function pinPad(title, sub, onDone) {
    let digits = '';
    const dots = el('div', { class: 'dots' });
    const err = el('div', { class: 'error' });
    const paint = () => { dots.textContent = '●'.repeat(digits.length) + '○'.repeat(4 - digits.length); };
    const press = (d) => {
      touch();
      if (d === 'back') digits = digits.slice(0, -1);
      else if (digits.length < 4) digits += d;
      paint();
      if (digits.length === 4) { const v = digits; digits = ''; setTimeout(paint, 250); onDone(v, (msg) => { err.textContent = msg; }); }
    };
    const keys = el('div', { class: 'keys' });
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) keys.append(el('button', { onclick: () => press(d) }, d));
    keys.append(el('button', { onclick: close }, 'Άκυρο'), el('button', { onclick: () => press('0') }, '0'), el('button', { onclick: () => press('back') }, '⌫'));
    paint();
    flow = { press };
    show(el('h2', {}, title), sub ? el('p', {}, sub) : null, dots, err, keys);
  }

  function startPin(p) {
    pinPad(p.name, 'Πληκτρολογήστε τον κωδικό σας (4 ψηφία).', async (pin, fail) => {
      let answer;
      try { answer = await flowApi('/api/pin', { employeeId: p.id, pin }); } catch (e) { return fail(OFFLINE); }
      const { status, data } = answer;
      if (status !== 200) return fail(data.text || 'Δεν έγινε. Δοκιμάστε ξανά.');
      if (data.mustChooseOwn) return chooseOwn(data);
      chooseType(data);
    });
  }

  function chooseOwn(session) {
    pinPad(session.name + ': νέος κωδικός', 'Είναι η πρώτη φορά: διαλέξτε τον ΔΙΚΟ σας κωδικό (4 ψηφία). Δεν τον λέτε σε κανέναν — ούτε στον εργοδότη.', (first) => {
      pinPad(session.name + ': ξανά', 'Πληκτρολογήστε τον ίδιο νέο κωδικό ξανά.', async (second, fail) => {
        if (first !== second) { chooseOwn(session); return; }
        let answer;
        try { answer = await flowApi('/api/own-pin', { ticket: session.ticket, newPin: first }); } catch (e) { return fail(OFFLINE); }
        const { status, data } = answer;
        if (status !== 200) {
          if (data.error === 'pin-refused') { chooseOwnWith(session, data.text); return; }
          return fail(data.text || 'Δεν έγινε.');
        }
        chooseType(data);
      });
    });
  }
  function chooseOwnWith(session, message) {
    chooseOwn(session);
    const err = document.querySelector('#panel .error');
    if (err) err.textContent = message;
  }

  function chooseType(session) {
    const last = session.last ? 'Τελευταία κίνηση: ' + TYPE[session.last.type] + ', ' + dayTime(session.last.at) + '.' : 'Δεν υπάρχει προηγούμενη κίνηση.';
    const btn = (t) => el('button', { class: 'big' + (session.suggestion === t ? ' suggested' : ''), onclick: () => confirmCard(session, t) }, TYPE_LONG[t]);
    flow = { press: () => {} };
    show(el('h2', {}, session.name), el('p', {}, last), btn('0'), btn('1'), el('div', {}, el('button', { class: 'small', onclick: close }, 'Άκυρο')));
  }

  function confirmCard(session, type) {
    // ONE tap sends: the ticket is single-use, and a second send's refusal would cover the first one's «Καταχωρήθηκε».
    const go = el('button', { class: 'big primary', onclick: () => { if (go.disabled) return; go.disabled = true; stamp(session, type); } }, 'Επιβεβαίωση');
    // «Again?» only against the server's own reading of the day (capture.ts, openShiftOf): yesterday's forgotten ΛΗΞΗ
    // leaves an ΕΝΑΡΞΗ as the last card, and this morning's ΕΝΑΡΞΗ must not be questioned for it.
    const again = session.last && session.last.type === type && type !== session.suggestion;
    show(el('h2', {}, 'Επιβεβαίωση'),
      el('p', { class: 'notice' }, session.name + ' — ' + TYPE_LONG[type]),
      el('p', {}, 'Ώρα: τώρα (' + hhmm(serverNow()) + ')'),
      again ? el('p', { class: 'warn' }, 'Προσοχή: η τελευταία σας κίνηση ήταν ήδη ' + TYPE[type] + ' (' + hhmm(session.last.at) + '). Σίγουρα ξανά ' + TYPE[type] + ';') : null,
      go,
      el('button', { class: 'big', onclick: close }, 'Άκυρο'));
  }

  async function stamp(session, type) {
    let status, data;
    try {
      ({ status, data } = await flowApi('/api/stamp', { ticket: session.ticket, type }));
    } catch (e) {
      // The connection broke: the card may or may not have been written (the answer can be lost too). Never silent,
      // never «done» — say so, and say what to do while the 15 minutes run.
      show(el('h2', {}, 'Δεν ξέρω αν καταχωρήθηκε'),
        el('p', { class: 'error' }, 'Η σύνδεση με τον server διακόπηκε. Δείτε τι γράφει δίπλα στο όνομά σας: αν δεν φαίνεται αυτή η κίνηση, ξεκινήστε πάλι από το όνομά σας — κι αν η σελίδα δεν απαντά, χτυπήστε με το CardScanner.'),
        el('button', { class: 'big', onclick: close }, 'Εντάξει'));
      refresh();
      return;
    }
    if (status !== 200) {
      show(el('h2', {}, 'Δεν καταχωρήθηκε'), el('p', { class: 'error' }, data.text || 'Δοκιμάστε ξανά από την αρχή.'), el('button', { class: 'big', onclick: close }, 'Εντάξει'));
      return;
    }
    const line = el('p', {}, 'Στέλνεται στην ΕΡΓΑΝΗ…');
    show(el('h2', {}, session.name), el('p', { class: 'ok' }, 'Καταχωρήθηκε ✓ ' + TYPE[type] + ' ' + hhmm(data.at)), line, el('button', { class: 'big', onclick: close }, 'Τέλος'));
    const mine = screen;
    const closeMine = () => { if (screen === mine) close(); };
    const started = Date.now();
    const poll = async () => {
      if (screen !== mine) return;
      const r = await api('/api/card/' + data.punchId).catch(() => null);
      const s = r && r.data && r.data.state;
      if (s && s.kind === 'filed') {
        line.className = 'ok';
        line.textContent = 'Στάλθηκε στην ΕΡΓΑΝΗ ✓ — αριθμός πρωτοκόλλου ' + s.protocol;
        setTimeout(closeMine, 8000);
        return;
      }
      if (Date.now() - started > 20000) {
        line.className = 'warn';
        line.textContent = 'Δεν έχει σταλεί ακόμη — το σύστημα ξαναδοκιμάζει μόνο του. Αν δεν σταλεί σε 5 λεπτά, θα δείτε κόκκινο μήνυμα εδώ.';
        if (s && s.problem) line.append(problemLine(s.problem));
        setTimeout(closeMine, 15000);
        return;
      }
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 800);
    refresh();
  }

  // ── The human queue: a person decides ───────────────────────────────────────────────────────
  function openDecide(q) {
    let choice = null;
    const choices = el('div', { class: 'choices' });
    if (q.canFileLate) {
      for (const [code, label] of REASONS) {
        choices.append(el('label', {}, el('input', { type: 'radio', name: 'c', onchange: () => { choice = { kind: 'file_late', reason: code }; } }), ' Αποστολή εκπρόθεσμα — αιτία: ' + label));
      }
    }
    choices.append(el('label', {}, el('input', { type: 'radio', name: 'c', onchange: () => { choice = { kind: 'covered' }; } }),
      ' Δεν στέλνεται από εδώ: χτυπήθηκε με το CardScanner / το αναλαμβάνει ο λογιστής'));
    const err = el('div', { class: 'error' });
    const who = el('div', { class: 'who' });
    for (const p of board.staff) {
      who.append(el('button', { class: 'small', onclick: () => {
        if (!choice) { err.textContent = 'Διαλέξτε πρώτα τι θα γίνει.'; return; }
        pinPad(p.name, 'Ο κωδικός σας, για να καταγραφεί ποιος το αποφάσισε.', async (pin, fail) => {
          let answer;
          try { answer = await flowApi('/api/decide', { punchId: q.punchId, employeeId: p.id, pin, kind: choice.kind, reason: choice.reason }); } catch (e) { return fail(OFFLINE); }
          const { status, data } = answer;
          if (status !== 200) return fail(data.text || 'Δεν έγινε.');
          close();
          refresh();
        });
      } }, p.name));
    }
    show(el('h2', {}, q.name + ' — ' + TYPE[q.type] + ' ' + dayHhmm(q.at)), dutyBox(), choices,
      el('p', {}, 'Ποιος/ποια το αποφασίζει;'), who, err, el('button', { class: 'small', onclick: close }, 'Άκυρο'));
  }

  document.addEventListener('keydown', (e) => {
    if ($('flow').hidden || !flow) return;
    if (/^[0-9]$/.test(e.key)) flow.press(e.key);
    else if (e.key === 'Backspace') flow.press('back');
    else if (e.key === 'Escape') close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  refresh();
  setInterval(refresh, 5000);
})();
`;
