// SPDX-License-Identifier: EUPL-1.2
import { networkInterfaces } from 'node:os';
import { answerProblems, bindAddressProblem, type BranchAnswers, type SetupAnswers } from '../../setup/settings.js';
import { passwordProblem } from './auth.js';
import { html, note, page, type Html } from './html.js';

/**
 * THE FIRST-RUN SETUP PAGE — what `ergani setup` asks (setup/cli.ts), as one form, checked by the same
 * `answerProblems`; plus the terms tick box and the owner's password. The Docker-only and optional parts are not asked
 * here: the instance name is fixed (`karta`, one employer per data folder), no proxy, no ntfy, no monitors.
 * A refused form comes back with every answer kept — except the passwords, which are never written into a page.
 */
export const INSTANCE = 'karta';
export const MAX_BRANCH_ROWS = 6;

/** This computer's private IPv4 addresses the staff page may listen on (setup's own rule), with their interface. */
export function privateAddresses(): Array<{ address: string; name: string }> {
  return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter((i) => i.family === 'IPv4' && !i.internal && bindAddressProblem(i.address) === undefined)
      .map((i) => ({ address: i.address, name })),
  );
}

export interface SetupForm {
  answers: SetupAnswers;
  ownerPassword: string;
  /** The easy phone alerts (nameless, through ntfy.sh): the owner's page «Ειδοποιήσεις» shows the QR. */
  alerts: boolean;
  /** Problems with what only this page asks: the terms, the owner password, the real-register confirmation. */
  ownProblems: string[];
  rows: number;
}

/** Read the posted form into answers — nothing judged yet beyond the page's own questions. */
export function readSetupForm(form: URLSearchParams, todayMonth: string): SetupForm {
  const get = (name: string) => (form.get(name) ?? '').trim();
  const raw = (name: string) => form.get(name) ?? '';
  const rows = Math.min(MAX_BRANCH_ROWS, Math.max(1, Number(get('rows')) || 1));
  const branches: BranchAnswers[] = [];
  for (let i = 0; i < rows; i += 1) {
    const code = get(`b${i}_code`);
    if (code === '' && i > 0) continue;
    branches.push({
      code,
      label: get(`b${i}_label`),
      inspectorateEmail: get(`b${i}_email`),
      schedule: form.get(`b${i}_none`) === 'on' ? 'none' : 'ergani',
      username: get(`b${i}_user`),
      password: raw(`b${i}_pass`),
    });
  }
  const realm = get('realm') === 'production' ? 'production' : 'trial';
  const ownProblems: string[] = [];
  if (form.get('terms') !== 'on') ownProblems.push('Όροι: χρειάζεται το τικ ότι το χρησιμοποιείτε με δική σας ευθύνη');
  if (realm === 'production' && form.get('real') !== 'on') {
    ownProblems.push('Πραγματικό μητρώο: επιβεβαιώστε ότι κάθε κάρτα θα είναι πραγματική δήλωση — ή διαλέξτε το δοκιμαστικό');
  }
  const ownerPassword = raw('owner');
  const problem = passwordProblem(ownerPassword);
  if (problem !== undefined) ownProblems.push(`Κωδικός του εργοδότη: ${problem}`);
  else if (raw('owner2') !== ownerPassword) ownProblems.push('Κωδικός του εργοδότη: οι δύο φορές διαφέρουν');
  for (const [i, b] of branches.entries()) {
    if (raw(`b${i}_pass2`) !== b.password) ownProblems.push(`Παράρτημα ${b.code || i}: οι δύο κωδικοί ΕΡΓΑΝΗ διαφέρουν`);
  }
  return {
    answers: {
      instance: INSTANCE,
      label: get('label'),
      employerAfm: get('afm'),
      realm,
      branches,
      bindAddress: get('address') || '127.0.0.1',
      port: Number(get('port') || '8880'),
      cookieSecure: false,
      ntfyUrl: '',
      ntfyToken: '',
      stampHeartbeatUrl: '',
      archiveHeartbeatUrl: '',
      archiveFrom: get('from') || todayMonth,
    },
    ownerPassword,
    alerts: form.get('alerts') === 'on',
    ownProblems,
    rows: Math.max(rows, branches.length),
  };
}

export function setupProblems(form: SetupForm): string[] {
  return [...form.ownProblems, ...answerProblems(form.answers)];
}

const blank = (todayMonth: string): SetupForm => ({
  answers: {
    instance: INSTANCE, label: '', employerAfm: '', realm: 'trial',
    branches: [{ code: '0', label: '', inspectorateEmail: '', schedule: 'ergani', username: '', password: '' }],
    bindAddress: '127.0.0.1', port: 8880, cookieSecure: false, ntfyUrl: '', ntfyToken: '',
    stampHeartbeatUrl: '', archiveHeartbeatUrl: '', archiveFrom: todayMonth,
  },
  ownerPassword: '',
  alerts: false,
  ownProblems: [],
  rows: 1,
});

/** The setup page: blank, or `form` sent back with its `problems`. */
export function setupPage(
  todayMonth: string,
  addresses: ReadonlyArray<{ address: string; name: string }>,
  form: SetupForm = blank(todayMonth),
  problems: readonly string[] = [],
): string {
  const a = form.answers;
  const checked = (on: boolean) => (on ? html` checked` : html``);
  const branchRows: Html[] = [];
  for (let i = 0; i < form.rows; i += 1) {
    const b = a.branches[i] ?? { code: '', label: '', inspectorateEmail: '', schedule: 'ergani', username: '', password: '' };
    branchRows.push(html`<fieldset><legend>${i === 0 ? 'Η έδρα ή το πρώτο παράρτημα' : `Παράρτημα ${i + 1}`}</legend>
<label for="b${i}_code">Αριθμός παραρτήματος όπως τον γράφει η ΕΡΓΑΝΗ (η έδρα είναι 0)</label>
<input type="text" id="b${i}_code" name="b${i}_code" value="${b.code}" inputmode="numeric">
<label for="b${i}_label">Όνομα στη σελίδα (π.χ. «Κέντρο» — χρειάζεται όταν είναι πάνω από ένα)</label>
<input type="text" id="b${i}_label" name="b${i}_label" value="${b.label}">
<label for="b${i}_user">Περιορισμένος χρήστης ΕΡΓΑΝΗ του παραρτήματος — όνομα χρήστη</label>
<input type="text" id="b${i}_user" name="b${i}_user" value="${b.username}" autocomplete="off">
<label for="b${i}_pass">Ο κωδικός του (8–12 χαρακτήρες)</label>
<input type="password" id="b${i}_pass" name="b${i}_pass" autocomplete="new-password">
<label for="b${i}_pass2">Ο ίδιος κωδικός ξανά</label>
<input type="password" id="b${i}_pass2" name="b${i}_pass2" autocomplete="new-password">
<label for="b${i}_email">Email της Επιθεώρησης Εργασίας της περιοχής (προαιρετικό)</label>
<input type="email" id="b${i}_email" name="b${i}_email" value="${b.inspectorateEmail}">
<p class="check"><input type="checkbox" id="b${i}_none" name="b${i}_none"${checked(b.schedule === 'none')}>
<label for="b${i}_none">Δεν έχει δηλωμένο σταθερό ωράριο στην ΕΡΓΑΝΗ (το ωράριο δηλώνεται κάθε εβδομάδα)</label></p>
</fieldset>`);
  }
  const addressChoices = [{ address: '127.0.0.1', name: '' }, ...addresses];
  const body = html`
${problems.length > 0 ? note('bad', html`Δεν αποθηκεύτηκε — διορθώστε:<br>${problems.map((p) => html`• ${p}<br>`)}`) : html``}
<p>Πρώτη ρύθμιση. Τίποτα δεν στέλνεται πουθενά μέχρι να πατήσετε «Αποθήκευση» — και τότε μόνο αποθηκεύεται σε αυτόν τον
υπολογιστή.</p>
<p>Αν αλλάξατε υπολογιστή: <a href="/restore">Επαναφορά από πλήρες αντίγραφο ασφαλείας</a>.</p>
<form method="post" action="/setup" autocomplete="off">
<input type="hidden" name="rows" value="${form.rows}">
<fieldset><legend>Όροι χρήσης</legend>
<p>Το πρόγραμμα είναι δωρεάν, χωρίς καμία εγγύηση. Κάθε κάρτα στο πραγματικό μητρώο είναι νόμιμη δήλωση του εργοδότη.</p>
<p class="check"><input type="checkbox" id="terms" name="terms">
<label for="terms">Το χρησιμοποιώ με δική μου ευθύνη· ως εργοδότης παραμένω υπεύθυνος για τις δηλώσεις μου στην ΕΡΓΑΝΗ.</label></p>
</fieldset>
<fieldset><legend>Ο εργοδότης</legend>
<label for="label">Το όνομα που θα γράφει η σελίδα (π.χ. «Οδοντιατρείο Παράδειγμα»)</label>
<input type="text" id="label" name="label" value="${a.label}">
<label for="afm">ΑΦΜ του εργοδότη</label>
<input type="text" id="afm" name="afm" value="${a.employerAfm}" inputmode="numeric">
</fieldset>
<fieldset><legend>Ο περιορισμένος χρήστης ΕΡΓΑΝΗ — ένας για κάθε παράρτημα</legend>
<p>Το πρόγραμμα <strong>δεν κρατά ποτέ τους κύριους κωδικούς</strong> σας. Για κάθε παράρτημα φτιάχνετε στην ΕΡΓΑΝΗ έναν
«Χρήστη Παραρτήματος» που μπορεί μόνο να δηλώνει κάρτες: <a href="/odigos">ο οδηγός βήμα βήμα</a>.</p>
</fieldset>
${branchRows}
${form.rows < MAX_BRANCH_ROWS ? html`<p><button class="secondary" name="more" value="1">+ Άλλο ένα παράρτημα</button></p>` : html``}
<fieldset><legend>Πού χτυπούν κάρτα οι εργαζόμενοι</legend>
${addressChoices.map(({ address, name }) => html`<p class="check"><input type="radio" id="ad_${address}" name="address" value="${address}"${checked(a.bindAddress === address)}>
<label for="ad_${address}">${address === '127.0.0.1' ? 'Μόνο σε αυτόν τον υπολογιστή' : `Και από κινητά στο Wi-Fi του ιατρείου — ${address} (${name})`}</label></p>`)}
<p class="hint">Τα κινητά πρέπει να είναι στο δίκτυο του ιατρείου, ποτέ στο Wi-Fi επισκεπτών. Καλό είναι ο ρούτερ να δίνει
πάντα την ίδια διεύθυνση σε αυτόν τον υπολογιστή.</p>
<label for="port">Θύρα (αφήστε 8880: στα Windows, αυτή ανοίγει ο εγκαταστάτης για τα κινητά)</label>
<input type="number" id="port" name="port" value="${a.port}" min="1024" max="65535">
</fieldset>
<fieldset><legend>ΕΡΓΑΝΗ: δοκιμαστικό ή πραγματικό</legend>
<p class="check"><input type="radio" id="realm_trial" name="realm" value="trial"${checked(a.realm === 'trial')}>
<label for="realm_trial">Δοκιμαστικό — ό,τι δηλώνεται σημαδεύεται «ΑΚΥΡΟ»</label></p>
<p class="check"><input type="radio" id="realm_prod" name="realm" value="production"${checked(a.realm === 'production')}>
<label for="realm_prod">Πραγματικό μητρώο</label></p>
<p class="check"><input type="checkbox" id="real" name="real">
<label for="real">Για το πραγματικό: καταλαβαίνω ότι κάθε κάρτα θα είναι πραγματική δήλωση για πραγματικό πρόσωπο.</label></p>
<label for="from">Από ποιον μήνα να κρατά το μηνιαίο αρχείο</label>
<input type="month" id="from" name="from" value="${a.archiveFrom}">
</fieldset>
<fieldset><legend>Ο κωδικός του εργοδότη για αυτές τις σελίδες</legend>
<p class="hint">Τον ζητά κάθε φορά που ανοίγετε τις σελίδες του εργοδότη — οι εργαζόμενοι χρησιμοποιούν τον ίδιο υπολογιστή.</p>
<label for="owner">Κωδικός (τουλάχιστον 10 χαρακτήρες)</label>
<input type="password" id="owner" name="owner" autocomplete="new-password">
<label for="owner2">Ο ίδιος ξανά</label>
<input type="password" id="owner2" name="owner2" autocomplete="new-password">
</fieldset>
<fieldset><legend>Ειδοποιήσεις στο κινητό σας</legend>
<p class="check"><input type="checkbox" id="alerts" name="alerts"${checked(form.alerts)}>
<label for="alerts">Ναι — όταν μια κάρτα δεν στάλθηκε ή κάποιος δεν χτύπησε, ένα σύντομο μήνυμα στο κινητό μου, <strong>χωρίς
ονόματα</strong> («δείτε τη σελίδα στο ιατρείο»). Δωρεάν, με την εφαρμογή ntfy· μετά τη ρύθμιση, η σελίδα «Ειδοποιήσεις» δείχνει
το QR και στέλνει μια ΔΟΚΙΜΗ.</label></p>
</fieldset>
<p><button name="save" value="1">Αποθήκευση</button></p>
</form>
<p class="hint">Δεν θέλετε να το φροντίζετε εσείς; <a href="https://odontia.ai">Η Odontia το τρέχει για εσάς</a>.</p>`;
  return page('Πρώτη ρύθμιση', body, { nav: false });
}
