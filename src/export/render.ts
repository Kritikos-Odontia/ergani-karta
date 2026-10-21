// SPDX-License-Identifier: EUPL-1.2
import type { HeldSchedule, HeldStamp, ReadDay } from '../records/store.js';
import {
  SCHEDULE,
  STAMPS,
  standing,
  type ComparedDay,
  type DayRange,
  type Difference,
  type EmployeeRecord,
  type MonthComparison,
  type RecordSource,
} from './model.js';

/**
 * THE PAGES — written for the person who opens them, in Greek: a labour inspector, an employee asking
 * what the employer holds about them, the owner reading the month. ⛔ Not a debug dump.
 *
 * ── SELF-CONTAINED, SO THEY OUTLIVE THIS APP ──────────────────────────────────────────────────────
 * One HTML file per page: styles inline, no script, no font, no image, no link to anything. It opens in
 * any browser, prints to paper or PDF from the browser's own menu, and reads the same in five years
 * when this code is gone. The CSV beside the export is the same rows for a spreadsheet: UTF-8 with a
 * BOM and `;` between fields, which is what Excel on a Greek-locale PC opens as columns on a double-click.
 *
 * ── ⛔⛔ ON THE FACE, NEVER IN A TOOLTIP ────────────────────────────────────────────────────────────
 * The comparison states, as body text at the top, (1) that it is up to a month behind, with the date of
 * the newest data and how many days old that is, and (2) that the accountant already reconciles this
 * daily — it is a cross-check, not a control. The pages use no `title` attribute at all.
 * The export states its freshness too: a day after the newest data is not "no stamp", it is not known.
 *
 * ⓘ Hours are shown exactly as ΕΡΓΑΝΗ sent them — their format is unmeasured — and every value is
 * HTML-escaped. Dates are written DD/MM/YYYY, as in every Greek document.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The per-employee export
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function employeePage(record: EmployeeRecord, generatedAt: number): string {
  const range = `${greekDate(record.from)} – ${greekDate(record.to)}`;
  const current = record.stamps.filter((s) => s.inLatestRead > 0).length;
  const earlier = record.stamps.length - current;
  const body = `
<h1>Ψηφιακή Κάρτα Εργασίας — καταγραφές έναρξης και λήξης εργασίας</h1>
${realmBanner(record.source)}
<p>Αντίγραφο των καταγραφών της ψηφιακής κάρτας εργασίας του εργαζομένου με τον παρακάτω ΑΦΜ, όπως τις
τηρεί ο εργοδότης στο δικό του αρχείο.</p>
<dl class="meta">
  <dt>ΑΦΜ εργαζομένου</dt><dd>${esc(record.afm)}</dd>
  <dt>Περίοδος</dt><dd>${range}</dd>
  <dt>Πηγή</dt><dd>ΠΣ ΕΡΓΑΝΗ ΙΙ, υπηρεσία ${STAMPS} «Ημερολόγιο Πραγματικής Απασχόλησης». Ο εργοδότης αντλεί
    τα στοιχεία από την ΕΡΓΑΝΗ κάθε μήνα και τα φυλάσσει.</dd>
  <dt>Δημιουργήθηκε</dt><dd>${athens(generatedAt).date} ${athens(generatedAt).time} (ώρα Ελλάδας)</dd>
</dl>
${freshnessNotice(record.source, generatedAt, 'stamps')}
<h2>Ημέρες της περιόδου χωρίς στοιχεία στο αρχείο</h2>
${
  record.unread.length === 0
    ? '<p>Καμία: για κάθε ημέρα της περιόδου το αρχείο έχει την απάντηση της ΕΡΓΑΝΗ.</p>'
    : `<p class="notice warn">Για τις παρακάτω ημέρες το αρχείο <strong>δεν έχει</strong> την απάντηση της ΕΡΓΑΝΗ.
Αν δεν εμφανίζεται καταγραφή σε αυτές, αυτό <strong>δεν σημαίνει</strong> ότι δεν υπήρξε: ${ranges(record.unread)}.</p>`
}
<h2>Καταγραφές (${record.stamps.length})</h2>
${
  record.stamps.length === 0
    ? '<p>Το αρχείο δεν έχει καμία καταγραφή για αυτόν τον ΑΦΜ στις ημέρες της περιόδου για τις οποίες έχει στοιχεία.</p>'
    : `<table>
<thead><tr><th>Ημερομηνία</th><th>Ημέρα</th><th>Έναρξη</th><th>Λήξη</th><th>Σημείωση</th></tr></thead>
<tbody>
${record.stamps
  .map(
    (s) =>
      `<tr${s.inLatestRead === 0 ? ' class="earlier"' : ''}><td>${greekDate(s.day)}</td><td>${weekday(s.day)}</td>` +
      `<td>${esc(s.hourFrom)}</td><td>${esc(s.hourTo)}</td><td>${stampNotes(s).map(esc).join('<br>')}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`
}
<p class="small">Οι ώρες εμφανίζονται ακριβώς όπως τις απέδωσε η ΕΡΓΑΝΗ. Ως ημερομηνία δίνεται η ημερομηνία
αναφοράς της εργάσιμης ημέρας· όταν η λήξη έπεσε την επόμενη ημερολογιακή ημέρα (βάρδια μετά τα μεσάνυχτα)
σημειώνεται.${
    earlier > 0
      ? ` Όταν η απάντηση της ΕΡΓΑΝΗ για μια ημέρα αλλάξει εκ των υστέρων, το αρχείο κρατά και την παλαιότερη
εκδοχή: ${earlier === 1 ? 'μία καταγραφή σημειώνεται' : `${earlier} καταγραφές σημειώνονται`} ως «παλαιότερη εκδοχή».`
      : ''
  }</p>`;
  return page(`Κάρτα εργασίας — ΑΦΜ ${record.afm} — ${range}`, body);
}

/** Why a stamp row needs a word beside it on the page. (The CSV carries the same facts as columns.) */
function stampNotes(s: HeldStamp): string[] {
  const notes: string[] = [];
  if (s.endsNextDay) notes.push('λήξη την επόμενη ημέρα');
  if (s.inLatestRead === 0) notes.push('παλαιότερη εκδοχή — η ΕΡΓΑΝΗ δεν την απαντά πλέον (διορθώθηκε ή αποσύρθηκε)');
  if (s.inLatestRead > 1) notes.push(`η ΕΡΓΑΝΗ την απαντά ${s.inLatestRead} φορές`);
  return notes;
}

/**
 * The export's rows for a spreadsheet: every stamp, one line each, values as ΕΡΓΑΝΗ sent them — except
 * that the ΑΦΜ is written as Excel text (`excelText`), so a leading zero survives the double-click.
 */
export function employeeCsv(record: EmployeeRecord): string {
  const header = [
    'ΑΦΜ',
    'Ημερομηνία αναφοράς',
    'Ημέρα',
    'Έναρξη',
    'Λήξη',
    'Λήξη την επόμενη ημέρα',
    'Κατάσταση',
    'Φορές στην τελευταία απάντηση της ΕΡΓΑΝΗ',
    'Α/Α παραρτήματος',
    'Date όπως το απέδωσε η ΕΡΓΑΝΗ',
  ];
  const rows = record.stamps.map((s) => [
    excelText(s.afm),
    greekDate(s.day),
    weekday(s.day),
    s.hourFrom,
    s.hourTo,
    s.endsNextDay ? 'ναι' : 'όχι',
    s.inLatestRead === 0 ? 'παλαιότερη εκδοχή — δεν απαντάται πλέον' : 'ισχύει',
    String(s.inLatestRead),
    s.branch,
    s.date,
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvField).join(';')).join('\r\n') + '\r\n';
}

/**
 * ⛔ Digits as TEXT for Excel. A bare `012345678` opens as the number 12345678 — a wrong ΑΦΜ, and saved
 * back that way. `="012345678"` is the form Excel (and LibreOffice) keep exactly as written. Only digits
 * are ever wrapped (an ΑΦΜ is checked as nine when read from ΕΡΓΑΝΗ), so the formula can hold nothing else.
 */
function excelText(digits: string): string {
  if (!/^[0-9]+$/.test(digits)) throw new Error('only digits are written as Excel text');
  return `="${digits}"`;
}

function csvField(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The month-late comparison
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function comparisonPage(c: MonthComparison, generatedAt: number): string {
  const title = `Κάρτα και δηλωμένο ωράριο — ${greekMonth(c.month)}`;
  const body = `
<h1>${esc(title)}</h1>
${realmBanner(c.source)}
${freshnessNotice(c.source, generatedAt, 'both')}
<div class="notice">
  <p><strong>Ο λογιστής σας το ελέγχει ήδη καθημερινά.</strong> Στο απολογιστικό σύστημα ο λογιστής συγκρίνει
  κάθε μέρα τις καταγραφές της κάρτας με το δηλωμένο ωράριο, για κάθε εργαζόμενο, και δηλώνει εκ των υστέρων
  ό,τι άλλαξε. Αυτή η σελίδα είναι μια δεύτερη ματιά στην ίδια δουλειά, έναν μήνα αργότερα.
  <strong>Δεν είναι ο έλεγχος και δεν είναι δίχτυ ασφαλείας</strong>: ό,τι φαίνεται εδώ έπρεπε να το έχει
  δει ο λογιστής την ίδια μέρα.</p>
  <p>Μια διαφορά <strong>δεν είναι λάθος ούτε παράβαση</strong>. Μετακινημένο ρεπό, υπερωρία, έκτη μέρα σε
  φορτωμένη εβδομάδα συμβαίνουν νόμιμα και δηλώνονται εκ των υστέρων. Η σελίδα δείχνει τη διαφορά· δεν την κρίνει.</p>
</div>
<dl class="meta">
  <dt>Μήνας</dt><dd>${greekMonth(c.month)}</dd>
  <dt>Πηγή</dt><dd>ΠΣ ΕΡΓΑΝΗ ΙΙ: ${STAMPS} «Ημερολόγιο Πραγματικής Απασχόλησης» (κάρτα) και ${SCHEDULE}
    «Τρέχουσα Κατάσταση ΨΟΧΕ» (δηλωμένο ωράριο), όπως τα αντλεί και τα φυλάσσει ο εργοδότης.</dd>
  <dt>Δημιουργήθηκε</dt><dd>${athens(generatedAt).date} ${athens(generatedAt).time} (ώρα Ελλάδας)</dd>
</dl>
<h2>Ημέρες του μήνα χωρίς στοιχεία στο αρχείο</h2>
${
  c.unread.stamps.length === 0 && c.unread.schedule.length === 0
    ? '<p>Καμία: για κάθε ημέρα του μήνα το αρχείο έχει και την κάρτα και το ωράριο.</p>'
    : `<div class="notice warn"><p>Για αυτές τις ημέρες το αρχείο δεν έχει την απάντηση της ΕΡΓΑΝΗ, οπότε
<strong>δεν γίνεται σύγκριση</strong> — η απουσία καταγραφής εκεί δεν σημαίνει τίποτα.</p><ul>
${c.unread.stamps.length > 0 ? `<li>Κάρτα (${STAMPS}): ${ranges(c.unread.stamps)}</li>` : ''}
${c.unread.schedule.length > 0 ? `<li>Ωράριο (${SCHEDULE}): ${ranges(c.unread.schedule)}</li>` : ''}
</ul></div>`
}
${
  c.employees.length === 0
    ? '<p>Το αρχείο δεν έχει καμία καταγραφή ούτε δηλωμένο ωράριο για αυτόν τον μήνα.</p>'
    : c.employees.map((e) => employeeSection(e.afm, e.days)).join('\n')
}`;
  return page(title, body);
}

function employeeSection(afm: string, days: readonly ComparedDay[]): string {
  const count = (s: ReturnType<typeof standing>) => days.filter((d) => standing(d.difference) === s).length;
  return `
<h2>ΑΦΜ ${esc(afm)}</h2>
<p>Ημέρες με διαφορά: <strong>${count('differs')}</strong> · ίδιες: ${count('same')} · δεν συγκρίθηκαν: ${count('not-compared')}</p>
<table>
<thead><tr><th>Ημερομηνία</th><th>Ημέρα</th><th>Δηλωμένο ωράριο</th><th>Κάρτα</th><th>Διαφορά</th></tr></thead>
<tbody>
${days
  .map(
    (d) =>
      `<tr class="${standing(d.difference)}"><td>${greekDate(d.day)}</td><td>${weekday(d.day)}</td>` +
      `<td>${cell(d.declared.map(declaredText), d.declaredEarlier.map(declaredText))}</td>` +
      `<td>${cell(d.stamped.map(stampedText), d.stampedEarlier.map(stampedText))}</td>` +
      `<td>${differenceText(d.difference)}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`;
}

/** Current values, then — marked, never compared — the versions ΕΡΓΑΝΗ no longer answers. */
function cell(current: string[], earlier: string[]): string {
  const now = current.length === 0 ? '—' : current.map(esc).join('<br>');
  const old = earlier.map((e) => `<div class="was">παλαιότερη εκδοχή, δεν απαντάται πλέον: ${esc(e)}</div>`);
  return now + old.join('');
}

function declaredText(r: HeldSchedule): string {
  const hours = r.hourFrom === '' && r.hourTo === '' ? '' : ` ${r.hourFrom}–${r.hourTo}`;
  // A break belongs to hours: measured, ΕΡΓΑΝΗ gives rest and leave rows a BreakMinutes too.
  const pause = hours === '' || r.breakMinutes === '' || r.breakMinutes === '0' ? '' : ` · διάλειμμα ${r.breakMinutes}′`;
  const extra = r.extra === '' ? '' : ` · Extra: ${r.extra}`;
  return `${r.type}${hours}${pause}${extra}`;
}

function stampedText(r: HeldStamp): string {
  return `${r.hourFrom}–${r.hourTo}${r.endsNextDay ? ' (λήξη την επόμενη ημέρα)' : ''}`;
}

function differenceText(d: Difference): string {
  switch (d.kind) {
    case 'not-read':
      return `δεν συγκρίθηκε: το αρχείο δεν έχει ${d.services
        .map((s) => (s === STAMPS ? 'την κάρτα' : 'το ωράριο'))
        .join(' ούτε ')} αυτής της ημέρας`;
    case 'unreadable-time':
      return 'δεν συγκρίθηκε: μια ώρα λείπει ή έχει μορφή που δεν αναγνωρίζεται — δείτε τις τιμές';
    case 'no-work':
      return 'χωρίς δηλωμένη εργασία, χωρίς καταγραφή';
    case 'declared-absence':
      return `δηλωμένη ημέρα χωρίς εργασία (${d.types.map(esc).join(', ')}), χωρίς καταγραφή`;
    case 'stamp-on-declared-absence':
      return `καταγραφή κάρτας σε ημέρα που το ωράριο δηλώνει ${d.types.map(esc).join(', ')}`;
    case 'stamp-without-declared-work':
      return 'καταγραφή κάρτας χωρίς δηλωμένο ωράριο εργασίας';
    case 'declared-work-without-stamp':
      return 'δηλωμένη εργασία χωρίς καταγραφή κάρτας';
    case 'interval-count':
      return `διαφορετικός αριθμός διαστημάτων: δηλωμένα ${d.declared}, στην κάρτα ${d.stamped}`;
    case 'intervals':
      if (standing(d) === 'same') return 'ίδιες ώρες';
      return d.deltas.map((x) => `${shift('έναρξη', x.start)} · ${shift('λήξη', x.end)}`).join('<br>');
  }
}

/** A delta, stamped minus declared, in words: «λήξη 1ω 30′ αργότερα». */
function shift(which: string, minutes: number): string {
  if (minutes === 0) return `${which} ίδια`;
  const a = Math.abs(minutes);
  const span = a < 60 ? `${a}′` : `${Math.floor(a / 60)}ω${a % 60 === 0 ? '' : ` ${a % 60}′`}`;
  return `${which} ${span} ${minutes > 0 ? 'αργότερα' : 'νωρίτερα'}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What both pages say about their source
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⛔ Anything not read from the real register says so at the top, in red: the config DEFAULTS to the
 * trial realm, whose filings the ministry marks «ΑΚΥΡΟ», and a page printed from a trial store must never
 * pass for the clinic's record.
 */
function realmBanner(source: RecordSource): string {
  const other = source.realms.filter((r) => r !== 'production');
  if (other.length === 0) return '';
  return `<p class="notice test">ΔΟΚΙΜΑΣΤΙΚΑ ΣΤΟΙΧΕΙΑ — ΟΧΙ ΤΟ ΠΡΑΓΜΑΤΙΚΟ ΑΡΧΕΙΟ ΤΟΥ ΕΡΓΟΔΟΤΗ. Αντλήθηκαν από ${other
    .map((r) => (r === 'trial' ? 'το δοκιμαστικό περιβάλλον της ΕΡΓΑΝΗ, όπου κάθε δήλωση φέρει τη σήμανση «ΑΚΥΡΟ»' : `περιβάλλον «${esc(r)}», όχι από την ΕΡΓΑΝΗ`))
    .join(' και ')}.</p>`;
}

/**
 * ⚠⚠ THE STALENESS STATEMENT. `EX_BASE_07/08` answer only for the previous month and earlier, so the
 * record is always behind — by up to a month, and by more if the monthly pull has not run. The notice
 * gives the newest day the record holds, when it was read, and how many days before this page that is.
 */
function freshnessNotice(source: RecordSource, generatedAt: number, which: 'stamps' | 'both'): string {
  const today = athens(generatedAt).iso;
  const newest = (label: string, read: ReadDay | undefined) =>
    read === undefined
      ? `<li>${label}: <strong>καμία</strong> — το αρχείο δεν έχει ακόμη καμία απάντηση της ΕΡΓΑΝΗ.</li>`
      : `<li>${label}: <strong>${greekDate(read.day)}</strong>, ${daysAgo(read.day, today)} πριν από τη δημιουργία
  αυτής της σελίδας (αντλήθηκαν από την ΕΡΓΑΝΗ στις ${athens(Date.parse(read.readAt)).date}).</li>`;
  const lines =
    which === 'stamps'
      ? newest('Νεότερη ημέρα με στοιχεία κάρτας στο αρχείο', source.newestStamps)
      : newest('Νεότερη ημέρα με στοιχεία κάρτας', source.newestStamps) +
        newest('Νεότερη ημέρα με δηλωμένο ωράριο', source.newestSchedule);
  return `<div class="notice warn">
  <p><strong>Έως και έναν μήνα πίσω — όχι η σημερινή εικόνα.</strong> Η ΕΡΓΑΝΗ δίνει αυτά τα στοιχεία στον
  εργοδότη μόνο για τον προηγούμενο μήνα και παλαιότερα, ποτέ για τον τρέχοντα. Γι' αυτό το αρχείο είναι πάντα
  πίσω — έως έναν μήνα, και περισσότερο αν η μηνιαία άντληση δεν έχει τρέξει. Ό,τι έγινε μετά τις παρακάτω
  ημερομηνίες δεν φαίνεται εδώ.</p>
  <ul>
  ${lines}
  </ul>
</div>`;
}

function daysAgo(day: string, today: string): string {
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return n === 1 ? '1 ημέρα' : `${n} ημέρες`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Writing dates, and the page itself
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
const MONTHS = [
  'Ιανουάριος',
  'Φεβρουάριος',
  'Μάρτιος',
  'Απρίλιος',
  'Μάιος',
  'Ιούνιος',
  'Ιούλιος',
  'Αύγουστος',
  'Σεπτέμβριος',
  'Οκτώβριος',
  'Νοέμβριος',
  'Δεκέμβριος',
];

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
const greekDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] as string;
const greekMonth = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

function ranges(runs: readonly DayRange[]): string {
  return runs.map((r) => (r.from === r.to ? greekDate(r.from) : `${greekDate(r.from)} – ${greekDate(r.to)}`)).join(', ');
}

const ATHENS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Athens',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant on the Athens clock: `DD/MM/YYYY`, `HH:MM`, and `YYYY-MM-DD`. */
function athens(instant: number): { date: string; time: string; iso: string } {
  const part = (type: string) => ATHENS.formatToParts(instant).find((p) => p.type === type)?.value ?? '';
  const iso = `${part('year')}-${part('month')}-${part('day')}`;
  return { date: greekDate(iso), time: `${part('hour')}:${part('minute')}`, iso };
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:62rem;margin:1.5rem auto;padding:0 1rem}
h1{font-size:1.35rem;margin:0 0 .8rem}h2{font-size:1.1rem;margin:1.6rem 0 .5rem}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1rem 0}dl.meta dt{font-weight:600}dl.meta dd{margin:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #888;padding:.3rem .5rem;text-align:left;vertical-align:top}
th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}
tr.differs td{background:#fff4e0}tr.not-compared td{background:#eef0f3}tr.earlier td{color:#555}
.was{color:#555;font-size:.9em;margin-top:.2rem}
.notice{border:2px solid #333;padding:.5rem .9rem;margin:1rem 0}.notice p{margin:.4rem 0}
.notice.warn{border-color:#b45309;background:#fff7ed}
.notice.test{border-color:#b91c1c;background:#fef2f2;color:#7f1d1d;font-weight:700}
.small{font-size:.85em;color:#333}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4;margin:14mm}
@media print{body{margin:0;max-width:none;font-size:11px}.notice{break-inside:avoid}}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body.trim()}
</body>
</html>
`;
}
