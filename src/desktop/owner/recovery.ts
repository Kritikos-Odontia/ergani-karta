// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import { loadEmployerConfig } from '../../config.js';
import { athensTime } from '../../stamp/athens.js';
import { loadStampSettings } from '../../stamp/config.js';
import { decide, openPunches } from '../../stamp/outbox.js';
import { openStampStore } from '../../stamp/store.js';
import type { DesktopPaths } from '../paths.js';
import { readDesktopState, writeDesktopState } from '../state.js';
import { csrfField, html, note, page } from './html.js';
import type { OwnerPage } from './server.js';

/** No stamping service, archive, or network client exists during recovery. The hold survives every restart. */
export function recoveryPages(paths: DesktopPaths, env: NodeJS.ProcessEnv, now: () => number, resume: () => Promise<void>): ReadonlyMap<string, OwnerPage> {
  const home: OwnerPage = async ({ method, form, csrf }) => {
    if (![paths.settings, paths.stampDb, paths.recordsDb].every(existsSync)) {
      return { body: page('Ελλιπής επαναφορά', note('bad', 'Η επαναφορά δεν ολοκληρώθηκε. Η αποστολή παραμένει σταματημένη. Κρατήστε το αντίγραφο και ολοκληρώστε την επαναφορά σε νέο άδειο φάκελο δεδομένων.'), { csrf }) };
    }
    const employer = loadEmployerConfig(env);
    const stamp = loadStampSettings(env);
    const db = openStampStore(paths.stampDb, { name: stamp.instance, realm: employer.erganiRealm, employerAfm: employer.employerAfm }, employer.branches.map((b) => b.branchCode));
    let message = html``;
    let ready = false;
    try {
      if (method === 'POST') {
        try {
          if (form.get('do') === 'covered') {
            decide(db, Number(form.get('card')), { kind: 'covered' }, { employeeId: undefined, label: 'ο εργοδότης — έλεγχος μετά την επαναφορά', deviceId: undefined }, now());
            message = note('ok', 'Καταγράφηκε: καλύφθηκε στην ΕΡΓΑΝΗ ή ανατέθηκε στον λογιστή· δεν θα σταλεί από εδώ.');
          } else if (form.get('do') === 'resume') {
            if (openPunches(db).length > 0 || form.get('checked') !== 'on') {
              message = note('bad', 'Ελέγξτε πρώτα όλες τις παλιές εκκρεμότητες και επιβεβαιώστε ότι ο παλιός υπολογιστής έχει σταματήσει.');
            } else ready = true;
          }
        } catch {
          message = note('bad', 'Η κάρτα δεν δέχεται ακόμη απόφαση. Αν το αντίγραφο είναι πολύ πρόσφατο, περιμένετε να λήξει το διάστημα αποστολής της και ξαναδοκιμάστε.');
        }
      }
      if (!ready) return { body: page('Έλεγχος μετά την επαναφορά', html`${message}
${note('warn', 'Η αποστολή παραμένει σταματημένη. Οι εργαζόμενοι χρησιμοποιούν το CardScanner μέχρι να ολοκληρώσετε τον έλεγχο.')}
<p>Σταματήστε το πρόγραμμα στον παλιό υπολογιστή. Το αντίγραφο μπορεί να δείχνει ως εκκρεμή μια κάρτα που στάλθηκε αργότερα. Ελέγξτε την στην ΕΡΓΑΝΗ με τον λογιστή· από εδώ δεν ξαναστέλνεται. Ό,τι χρειάζεται διόρθωση ανατίθεται στον λογιστή.</p>
${openPunches(db).map((p) => html`<form method="post" action="/"><fieldset><legend>${p.surname} ${p.firstName} — ${p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ'} ${athensTime(p.eventMs).date} ${athensTime(p.eventMs).time.slice(0, 5)} — παράρτημα ${p.branch}</legend>${csrfField(csrf)}<input type="hidden" name="do" value="covered"><input type="hidden" name="card" value="${p.id}"><button>Ελέγχθηκε / ανατέθηκε στον λογιστή — να μη σταλεί</button></fieldset></form>`)}
<form method="post" action="/">${csrfField(csrf)}<input type="hidden" name="do" value="resume">
<p class="check"><input type="checkbox" id="checked" name="checked"><label for="checked">Ο παλιός υπολογιστής έχει σταματήσει, έλεγξα τις εκκρεμότητες με τον λογιστή και τις κάρτες μετά το αντίγραφο.</label></p><button>Ολοκλήρωση ελέγχου και εκκίνηση</button></form>`, { csrf }) };
    } finally {
      db.close();
    }
    const { recovery: _hold, ...state } = readDesktopState(paths.desktop)!;
    writeDesktopState(paths.desktop, state);
    await resume();
    return { redirect: '/' };
  };
  return new Map([['/', home]]);
}
