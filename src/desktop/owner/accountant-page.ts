// SPDX-License-Identifier: EUPL-1.2
import { accountantPeriod, writeAccountantExport } from '../../export/accountant.js';
import { athensTime } from '../../stamp/athens.js';
import type { StampStore } from '../../stamp/store.js';
import type { DesktopPaths } from '../paths.js';
import { openInBrowser } from '../open.js';
import { csrfField, html, note, page } from './html.js';
import type { OwnerPage } from './server.js';

export function accountantPage(o: { db: StampStore; paths: DesktopPaths; now: () => number; branchName: (code: string) => string; openFolders: boolean; log: (line: string) => void }): OwnerPage {
  return ({ method, form, csrf }) => {
    let message = html``;
    const month = athensTime(o.now()).date.slice(0, 7);
    if (method === 'POST') {
      try {
        const period = accountantPeriod({ month: form.get('month') ?? '', from: form.get('from') ?? '', to: form.get('to') ?? '' }, month);
        const exported = writeAccountantExport({ db: o.db, recordsPath: o.paths.recordsDb, out: o.paths.exports, period, nowMs: o.now(), branchName: o.branchName });
        if (o.openFolders) openInBrowser(exported.folder, o.log);
        message = note('ok', html`Το αρχείο δημιουργήθηκε:<br><code>${exported.zip}</code><br>Στον ίδιο φάκελο υπάρχουν τα CSV και ο φάκελος με τα αποδεικτικά PDF.${o.openFolders ? ' Ο φάκελος άνοιξε.' : ''}`);
      } catch (error) { message = note('bad', `Δεν έγινε: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { body: page('Αρχείο για τον λογιστή', html`${message}
<p>Ένα ZIP με τις κινήσεις, κάθε προσπάθεια υποβολής, τις εκκρεμότητες και τα διαθέσιμα αποδεικτικά PDF. Τα CSV ανοίγουν στο Excel με ελληνικά.</p>
<p>Κάθε γραμμή γράφει την πηγή της: <strong>τοπική καταγραφή</strong> ή <strong>ανάγνωση από την ΕΡΓΑΝΗ</strong>. Το πρωτόκολλο επιβεβαιώνει την υποβολή· δεν σημαίνει ότι η κάρτα ελέγχθηκε και στο μηνιαίο αρχείο. Η εξαγωγή διαβάζει μόνο όσα έχουν ήδη αποθηκευτεί, χωρίς νέα σύνδεση με την ΕΡΓΑΝΗ.</p>
<form method="post" action="/accountant"><fieldset>${csrfField(csrf)}
<label for="month">Μήνας (προεπιλογή: ο τρέχων)</label><input type="month" id="month" name="month" value="${month}">
<p>Ή συγκεκριμένη περίοδος — συμπληρώστε και τις δύο ημερομηνίες:</p>
<label for="from">Από εργάσιμη ημέρα</label><input type="date" id="from" name="from">
<label for="to">Έως εργάσιμη ημέρα</label><input type="date" id="to" name="to">
<p><button>Δημιουργία ZIP</button></p></fieldset></form>
${note('warn', 'Το ZIP περιέχει ΑΦΜ και ώρες εργασίας. Παραδώστε το μόνο στον λογιστή σας και φυλάξτε το με ασφάλεια. Δεν περιέχει κωδικό ΕΡΓΑΝΗ ή PIN.')}`, { csrf }) };
  };
}
