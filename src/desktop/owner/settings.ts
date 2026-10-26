// SPDX-License-Identifier: EUPL-1.2
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadEmployerConfig, BRANCH_CODE } from '../../config.js';
import { ErganiClient } from '../../ergani/client.js';
import { WORK_CARD_CODE } from '../../ergani/types.js';
import { inTransaction } from '../../records/store.js';
import { valueProblem } from '../../setup/settings.js';
import { branchRetired } from '../../stamp/branch-status.js';
import { loadStampSettings } from '../../stamp/config.js';
import { allStaff, renamePerson } from '../../stamp/staff.js';
import { addBranch, isoOf, storeBranches, type StampStore } from '../../stamp/store.js';
import { parseSettings, serviceEnv } from '../settings-file.js';
import { readDesktopState, writeDesktopState } from '../state.js';
import { hashPassword, OwnerSessions, passwordProblem } from './auth.js';
import { csrfField, html, note, page, type Html } from './html.js';
import type { PagesContext } from './pages.js';
import type { OwnerPage } from './server.js';

const OWNER = 'ο εργοδότης (από τις σελίδες του)';

/** Patch only the requested keys: settings made by the CLI and unknown options survive a screen edit. */
function patchSettings(path: string, changes: Record<string, string>): void {
  const left = new Set(Object.keys(changes));
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).map((line) => {
    const key = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(changes, key)) return line;
    left.delete(key);
    return `${key}=${changes[key]}`;
  });
  for (const key of left) lines.push(`${key}=${changes[key]}`);
  const temporary = `${path}.new`;
  writeFileSync(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function name(value: string, max = 120): string {
  const problem = valueProblem(value, 'allowed');
  if (value.trim() === '' || value.length > max || problem !== undefined) throw new Error(`Όνομα: 1–${max} χαρακτήρες${problem === undefined ? '' : `, ${problem}`}.`);
  return value;
}

export function settingsPage(c: PagesContext, db: StampStore): OwnerPage {
  const oldPasswords = new OwnerSessions(c.now);
  // Serialize file changes, including the reload and check: two browser tabs must not race the services' restart.
  let saving = false;
  const env = () => serviceEnv(c.paths, c.env);
  const record = (kind: string, subject: string, detail: unknown) => {
    db.prepare('INSERT INTO settings_events (at, kind, subject, detail, by) VALUES (?, ?, ?, ?, ?)')
      .run(isoOf(c.now()), kind, subject, JSON.stringify(detail), OWNER);
  };
  const apply = async (changes: Record<string, string>, kind: string, subject: string, detail: unknown) => {
    // Validate the whole proposed configuration before either file or store is changed. Errors name keys, not values.
    const candidate = { ...env(), ...changes };
    loadEmployerConfig(candidate);
    loadStampSettings(candidate);
    patchSettings(c.paths.settings, changes);
    record(kind, subject, detail);
    await c.reloadSettings?.();
  };
  const check = async (branch: string): Promise<Html> => {
    try {
      const config = loadEmployerConfig(env()).branches.find((b) => b.branchCode === branch)!;
      const forms = await new ErganiClient(config).listSubmissions();
      return forms.some((f) => f.code === WORK_CARD_CODE)
        ? note('ok', 'Ο νέος χρήστης συνδέθηκε και η WRKCardSE εμφανίζεται στη λίστα εντύπων. Δεν στάλθηκε κάρτα. Επιβεβαιώστε στην ΕΡΓΑΝΗ ότι ανήκει στο σωστό παράρτημα και έχει μόνο τη δήλωση κάρτας και μόνο μέσω API — ο έλεγχος δεν αποδεικνύει τους περιορισμούς ή την επιτυχή υποβολή.')
        : note('bad', 'Ο έλεγχος απέτυχε: η WRKCardSE δεν εμφανίζεται για τον νέο χρήστη. Ελέγξτε τα δικαιώματά του στην ΕΡΓΑΝΗ. Δεν στάλθηκε κάρτα.');
    } catch {
      // Never render a remote error here: a server could echo the credential it was just given.
      return note('bad', 'Ο έλεγχος σύνδεσης απέτυχε. Οι νέοι κωδικοί αποθηκεύτηκαν· διορθώστε τους εδώ και δοκιμάστε ξανά. Δεν στάλθηκε κάρτα.');
    }
  };

  return async ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      if (saving) return { status: 409, body: page('Ρυθμίσεις', note('warn', 'Αποθηκεύεται ήδη μια αλλαγή. Περιμένετε λίγο και δοκιμάστε ξανά.'), { csrf }) };
      saving = true;
      try {
        const todo = form.get('do');
        const values = parseSettings(readFileSync(c.paths.settings, 'utf8'));
        const current = loadStampSettings(env());
        const branch = form.get('branch') ?? '';
        const requireBranch = () => {
          if (!storeBranches(db).includes(branch)) throw new Error('Το παράρτημα δεν υπάρχει.');
        };
        const credentials = () => {
          const username = form.get('username') ?? '';
          const password = form.get('password') ?? '';
          if (username.length < 8 || username.length > 20 || valueProblem(username, 'refused') !== undefined) throw new Error('Χρήστης ΕΡΓΑΝΗ: 8–20 χαρακτήρες, χωρίς κενά ή ειδικούς χαρακτήρες του αρχείου ρυθμίσεων.');
          if (password.length < 8 || password.length > 12 || valueProblem(password, 'refused') !== undefined) throw new Error('Κωδικός ΕΡΓΑΝΗ: 8–12 χαρακτήρες, χωρίς κενά ή ειδικούς χαρακτήρες του αρχείου ρυθμίσεων.');
          if (password !== form.get('password2')) throw new Error('Οι δύο νέοι κωδικοί ΕΡΓΑΝΗ διαφέρουν.');
          return { [`ERGANI_BRANCH_${branch}_USERNAME`]: username, [`ERGANI_BRANCH_${branch}_PASSWORD`]: password };
        };
        switch (todo) {
          case 'password': {
            const state = readDesktopState(c.paths.desktop)!;
            const verified = oldPasswords.signIn(form.get('old') ?? '', state.ownerPassword);
            if (verified.kind === 'locked') throw new Error('Πολλοί λάθος παλιοί κωδικοί. Ξαναδοκιμάστε σε 10 λεπτά.');
            if (verified.kind !== 'ok') throw new Error('Λάθος παλιός κωδικός εργοδότη.');
            oldPasswords.signOut(verified.token);
            const password = form.get('password') ?? '';
            const problem = passwordProblem(password);
            if (problem !== undefined) throw new Error(`Νέος κωδικός εργοδότη: ${problem}.`);
            if (password !== form.get('password2')) throw new Error('Οι δύο νέοι κωδικοί εργοδότη διαφέρουν.');
            writeDesktopState(c.paths.desktop, { ...state, ownerPassword: hashPassword(password) });
            record('owner-password-changed', 'owner', {});
            return { redirect: '/login' };
          }
          case 'practice': {
            const label = name(form.get('label') ?? '');
            await apply({ STAMP_LABEL: label }, 'practice-renamed', 'practice', { before: current.label, after: label });
            message = note('ok', 'Το όνομα του ιατρείου διορθώθηκε. Οι παλιές καταγραφές διατηρούνται.');
            break;
          }
          case 'employee':
            renamePerson(db, form.get('afm') ?? '', { surname: form.get('surname') ?? '', firstName: form.get('first') ?? '', displayName: form.get('display') ?? '' }, OWNER, c.now());
            message = note('ok', 'Το όνομα διορθώθηκε για τις επόμενες κάρτες. Οι παλιές κάρτες διατηρούν το αρχικό όνομα.');
            break;
          case 'connection':
            requireBranch();
            await apply(credentials(), 'connection-changed', branch, {});
            message = await check(branch);
            break;
          case 'branch-name': {
            requireBranch();
            const label = name(form.get('label') ?? '', 40);
            await apply({ [`STAMP_BRANCH_${branch}_LABEL`]: label }, 'branch-renamed', branch, { before: current.branches.find((b) => b.code === branch)!.label, after: label });
            message = note('ok', 'Το όνομα του παραρτήματος διορθώθηκε. Οι παλιές καταγραφές διατηρούνται.');
            break;
          }
          case 'add-branch': {
            if (!BRANCH_CODE.test(branch)) throw new Error('Αριθμός παραρτήματος: όπως στην ΕΡΓΑΝΗ, χωρίς μηδενικά μπροστά (0, 1, 2…).');
            if (storeBranches(db).includes(branch)) throw new Error('Το παράρτημα υπάρχει ήδη.');
            const label = name(form.get('label') ?? '', 40);
            const schedule = form.get('schedule') ?? 'ergani';
            if (!['ergani', 'none'].includes(schedule)) throw new Error('Επιλέξτε αν διαβάζεται το ωράριο.');
            const changes = { ...credentials(), ERGANI_BRANCHES: [...storeBranches(db), branch].join(','), [`STAMP_BRANCH_${branch}_LABEL`]: label, [`STAMP_BRANCH_${branch}_SCHEDULE`]: schedule };
            // A formerly single branch may have no label; give it its existing practice heading when adding a second.
            for (const b of current.branches) if (b.label === '') Object.assign(changes, { [`STAMP_BRANCH_${b.code}_LABEL`]: current.label.slice(0, 40) });
            loadEmployerConfig({ ...env(), ...changes });
            loadStampSettings({ ...env(), ...changes });
            // Save the file before the store transaction: if the write fails there is no branch without a login.
            patchSettings(c.paths.settings, changes);
            inTransaction(db, () => { addBranch(db, branch, isoOf(c.now())); record('branch-added', branch, { label }); });
            await c.reloadSettings?.();
            message = html`${note('ok', 'Το παράρτημα προστέθηκε. Εγγράψτε τη συσκευή του από τις «Συσκευές».')}${await check(branch)}`;
            break;
          }
          case 'retire-branch':
            requireBranch();
            if (!branchRetired(db, branch)) record('branch-retired', branch, { label: values[`STAMP_BRANCH_${branch}_LABEL`] ?? '' });
            await c.reloadSettings?.();
            message = note('ok', 'Το παράρτημα έχει αποσυρθεί: δεν δέχεται νέες κάρτες. Το ιστορικό, οι εκκρεμείς κάρτες και η σύνδεσή του διατηρούνται.');
            break;
          default: throw new Error('Άγνωστη ενέργεια.');
        }
      } catch (error) {
        message = note('bad', `Δεν ολοκληρώθηκε: ${error instanceof Error ? error.message : 'σφάλμα αποθήκευσης'}`);
      } finally { saving = false; }
    }
    const current = loadStampSettings(env());
    const connection = (branch: string) => html`
<label>Περιορισμένος χρήστης ΕΡΓΑΝΗ (8–20 χαρακτήρες)<input name="username" type="text" autocomplete="off" required minlength="8" maxlength="20"></label>
<label>Νέος κωδικός ΕΡΓΑΝΗ (8–12 χαρακτήρες)<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="12"></label>
<label>Ξανά ο νέος κωδικός ΕΡΓΑΝΗ<input name="password2" type="password" autocomplete="new-password" required></label>
<p class="hint">Μόνο Χρήστης Παραρτήματος ${branch}, με δικαίωμα μόνο στη δήλωση κάρτας μέσω API. <a href="/odigos">Οδηγίες</a>. Μετά την αποθήκευση γίνεται έλεγχος μόνο ανάγνωσης.</p>`;
    const actionForm = (todo: string, content: Html, branch = '') => html`<form method="post" action="/settings">${csrfField(csrf)}<input type="hidden" name="do" value="${todo}"><input type="hidden" name="branch" value="${branch}">${content}<p><button>Αποθήκευση</button></p></form>`;
    return { body: page('Ρυθμίσεις', html`${message}
<p>Οι αλλαγές εφαρμόζονται χωρίς επανεκκίνηση του υπολογιστή. Η σελίδα των εργαζομένων ξανανοίγει προσωρινά με τις νέες ρυθμίσεις· ολοκληρώνεται πρώτα η αποστολή που βρίσκεται σε εξέλιξη.</p>
<fieldset><legend>Όνομα ιατρείου</legend>${actionForm('practice', html`<label>Όνομα στη σελίδα<input name="label" type="text" value="${current.label}" required maxlength="120"></label>`)}</fieldset>
<fieldset><legend>Κωδικός εργοδότη</legend>${actionForm('password', html`<label>Παλιός κωδικός<input name="old" type="password" autocomplete="current-password" required></label><label>Νέος κωδικός (τουλάχιστον 10 χαρακτήρες)<input name="password" type="password" autocomplete="new-password" required minlength="10"></label><label>Ξανά ο νέος κωδικός<input name="password2" type="password" autocomplete="new-password" required></label><p>Με την αλλαγή αποσυνδέονται όλες οι ανοιχτές συνδέσεις εργοδότη.</p>`)}</fieldset>
<h3>Διόρθωση ονόματος εργαζομένου</h3><p>Ο ΑΦΜ παραμένει ίδιος. Οι παλιές κάρτες δεν ξαναγράφονται και τίποτα δεν δηλώνεται στην ΕΡΓΑΝΗ.</p>
${allStaff(db).map((p) => html`<fieldset><legend>${p.displayName}</legend>${actionForm('employee', html`<input name="afm" type="hidden" value="${p.afm}"><label>Επώνυμο όπως στην ΕΡΓΑΝΗ<input name="surname" type="text" value="${p.surname}" required maxlength="50"></label><label>Όνομα όπως στην ΕΡΓΑΝΗ<input name="first" type="text" value="${p.firstName}" required maxlength="30"></label><label>Όνομα στη σελίδα<input name="display" type="text" value="${p.displayName}" required maxlength="80"></label>`)}</fieldset>`)}
<h3>Παραρτήματα και σύνδεση</h3>
${current.branches.map((b) => html`<fieldset><legend>Παράρτημα ${b.code} — ${b.label || current.label}</legend>
${branchRetired(db, b.code) ? note('warn', 'Έχει αποσυρθεί. Το ιστορικό και η σύνδεση διατηρούνται· δεν δέχεται νέες κάρτες.') : html``}
${actionForm('branch-name', html`<label>Όνομα παραρτήματος<input name="label" type="text" value="${b.label || current.label}" required maxlength="40"></label>`, b.code)}
<details><summary>Αλλαγή σύνδεσης ΕΡΓΑΝΗ</summary>${actionForm('connection', connection(b.code), b.code)}</details>
${branchRetired(db, b.code) ? html`` : html`<form method="post" action="/settings">${csrfField(csrf)}<input name="do" type="hidden" value="retire-branch"><input name="branch" type="hidden" value="${b.code}"><p>Απόσυρση μόνο όταν δεν εργάζεται πια κανείς εδώ. Σταματά τις νέες κάρτες, διατηρεί το ιστορικό και τις εκκρεμότητες.</p><p><button class="secondary">Απόσυρση παραρτήματος</button></p></form>`}</fieldset>`)}
<fieldset><legend>Νέο παράρτημα</legend><form method="post" action="/settings">${csrfField(csrf)}<input name="do" type="hidden" value="add-branch">
<label>Αριθμός όπως στην ΕΡΓΑΝΗ<input name="branch" type="text" inputmode="numeric" required></label><label>Όνομα παραρτήματος<input name="label" type="text" required maxlength="40"></label>
${connection('του νέου παραρτήματος')}<label>Ανάγνωση δηλωμένου ωραρίου<select name="schedule"><option value="ergani">Από την ΕΡΓΑΝΗ</option><option value="none">Χωρίς σταθερό δηλωμένο ωράριο</option></select></label><p><button>Προσθήκη</button></p></form></fieldset>`, { csrf }) };
  };
}
