// SPDX-License-Identifier: EUPL-1.2
import { inTransaction } from '../../records/store.js';
import { calendarDays, markCalendar } from '../../stamp/calendar.js';
import { athensTime } from '../../stamp/athens.js';
import { nationalHolidays } from '../../stamp/holidays.js';
import { isQuietDay, markQuietDay } from '../../stamp/schedule.js';
import { allStaff } from '../../stamp/staff.js';
import type { StampStore } from '../../stamp/store.js';
import { csrfField, html, note, page } from './html.js';
import type { OwnerPage } from './server.js';

export function calendarPage(db: StampStore, branches: readonly { code: string; label: string }[], now: () => number): OwnerPage {
  return ({ method, form, query, csrf }) => {
    let message = html``;
    const today = athensTime(now()).date;
    const requested = query.get('year') ?? today.slice(0, 4);
    const year = /^\d{4}$/.test(requested) && Number(requested) >= 1900 && Number(requested) <= 2199 ? Number(requested) : Number(today.slice(0, 4));
    if (method === 'POST') {
      try {
        const action = form.get('do');
        const from = form.get('from') ?? '';
        const to = form.get('to') || from;
        const reason = (form.get('reason') ?? '').trim();
        if (action === 'quiet' || action === 'unquiet') {
          const days = calendarDays(from, to);
          if (reason.length > 500) throw new Error('Γράψτε σύντομο λόγο.');
          inTransaction(db, () => { for (const day of days) markQuietDay(db, day, action === 'quiet', reason, 'ο εργοδότης (ημερολόγιο)', now()); });
        } else if (action === 'leave' || action === 'hours' || action === 'reset') {
          markCalendar(db, { from, to, employeeId: Number(form.get('employee')), branch: form.get('branch') || undefined,
            kind: action, hours: form.get('hours') ?? '', reason }, 'ο εργοδότης (ημερολόγιο)', now());
        } else throw new Error('Διαλέξτε ενέργεια.');
        message = note('ok', 'Καταγράφηκε για τις υπενθυμίσεις. Δεν δηλώθηκε ωράριο στην ΕΡΓΑΝΗ.');
      } catch (error) { message = note('bad', `Δεν έγινε: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const people = allStaff(db);
    const history = db.prepare(`SELECT c.*, e.display_name FROM reminder_calendar c JOIN employees e ON e.id = c.employee_id
      WHERE day BETWEEN ? AND ? ORDER BY day DESC, c.id DESC`).all(`${year}-01-01`, `${year}-12-31`);
    const closed = db.prepare('SELECT * FROM quiet_days WHERE day BETWEEN ? AND ? ORDER BY day DESC, id DESC').all(`${year}-01-01`, `${year}-12-31`);
    return { body: page('Ημερολόγιο υπενθυμίσεων', html`${message}
${note('warn', 'Μόνο υπενθυμίσεις: το ημερολόγιο δεν δηλώνει ωράριο ή άδεια στην ΕΡΓΑΝΗ. Οι δηλώσεις μένουν στον λογιστή.')}
<p>Η άδεια σταματά την υπενθύμιση ΕΝΑΡΞΗΣ μόνο για τον εργαζόμενο. Οι αλλαγμένες ώρες αντικαθιστούν το παλιό ωράριο μόνο στο παράρτημα που διαλέγετε, ακόμη κι αν εκεί δεν διαβάζεται ωράριο. Οι ειδοποιήσεις για κάρτες που δεν στάλθηκαν και για πραγματική ανοικτή ΕΝΑΡΞΗ συνεχίζονται.</p>
<form method="post" action="/calendar"><fieldset><legend>Άδεια ή αλλαγή ωρών</legend>${csrfField(csrf)}
<label for="employee">Εργαζόμενος</label><select id="employee" name="employee">${people.map((p) => html`<option value="${p.id}">${p.displayName}</option>`)}</select>
<label for="from">Από</label><input type="date" id="from" name="from" value="${today}" required>
<label for="to">Έως (κενό: ίδια ημέρα)</label><input type="date" id="to" name="to">
<label for="branch">Παράρτημα — για αλλαγή ωρών ή άρση της</label><select id="branch" name="branch"><option value="">Όλα — για άδεια ή άρση άδειας</option>${branches.map((b) => html`<option value="${b.code}">${b.label || b.code}</option>`)}</select>
<label for="hours">Ώρες — για αλλαγή ωρών</label><input type="text" id="hours" name="hours" placeholder="09:00-13:00,17:00-21:00">
<label for="reason">Σύντομος λόγος (χωρίς στοιχεία υγείας)</label><input type="text" id="reason" name="reason" maxlength="500" required>
<p><button name="do" value="leave">Άδεια</button> <button name="do" value="hours">Αλλαγή ωρών</button> <button class="secondary" name="do" value="reset">Άρση για την επιλογή</button></p>
<p class="hint">Για άδεια διαλέξτε «Όλα». Για άρση άδειας επίσης «Όλα»· για άρση αλλαγής ωρών διαλέξτε το ίδιο παράρτημα. Κάθε άρση κρατιέται στο ιστορικό.</p></fieldset></form>
<form method="post" action="/calendar"><fieldset><legend>Κλειστή μέρα / αργία για όλο το ιατρείο</legend>${csrfField(csrf)}
<label for="closedFrom">Από</label><input type="date" id="closedFrom" name="from" value="${today}" required>
<label for="closedTo">Έως (κενό: ίδια ημέρα)</label><input type="date" id="closedTo" name="to">
<label for="closedReason">Λόγος</label><input type="text" id="closedReason" name="reason" maxlength="500" required>
<p><button name="do" value="quiet">Κλειστή</button> <button class="secondary" name="do" value="unquiet">Ανοικτή — και σε ενσωματωμένη αργία</button></p></fieldset></form>
<form method="get" action="/calendar"><label for="year">Έτος</label><input type="number" id="year" name="year" value="${year}" min="1900" max="2199"><button class="secondary">Προβολή</button></form>
<h3>Ενσωματωμένες αργίες ${year}</h3>
<p>Δεν αναμένεται ΕΝΑΡΞΗ αυτές τις ημέρες. Επιβεβαιώστε με τον λογιστή τις μεταφορές της Πρωτομαγιάς και τυχόν τοπικές ή έκτακτες αργίες· σημειώστε τις εδώ. Για μεταφορά, σημειώστε την αρχική ημέρα ανοικτή και τη νέα κλειστή.</p>
<ul>${nationalHolidays(year).map((h) => html`<li>${h.day} — ${h.name}${isQuietDay(db, h.day) ? ' · κλειστή' : ' · σημειώθηκε ανοικτή'}</li>`)}</ul>
<h3>Καταγραφές ${year} — η νεότερη ανά ημέρα και επιλογή ισχύει</h3>
<table><tr><th>Ημέρα / άτομο</th><th>Επιλογή</th><th>Λόγος / καταγράφηκε</th></tr>
${history.map((r) => html`<tr><td>${r['day']} — ${r['display_name']}</td><td>${r['kind'] === 'leave' ? 'Άδεια' : r['kind'] === 'hours' ? 'Ώρες' : 'Άρση'} · ${r['branch'] === null ? 'Όλα' : branches.find((b) => b.code === r['branch'])?.label || r['branch']} · ${r['kind'] === 'hours' ? (JSON.parse(String(r['intervals'])) as Array<{ start: string; end: string }>).map((iv) => `${iv.start}–${iv.end}`).join(', ') : ''}</td><td>${r['reason']} · ${r['at']}</td></tr>`)}
${closed.map((r) => html`<tr><td>${r['day']} — Όλο το ιατρείο</td><td>${r['quiet'] === 1 ? 'Κλειστή' : 'Ανοικτή'}</td><td>${r['reason']} · ${r['at']}</td></tr>`)}</table>`, { csrf }) };
  };
}
