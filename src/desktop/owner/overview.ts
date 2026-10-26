// SPDX-License-Identifier: EUPL-1.2
import { athensTime } from '../../stamp/athens.js';
import { cardsMissingProof, EVIDENCE_GIVE_UP_MS, openPunches, stateOfPunch } from '../../stamp/outbox.js';
import { personById } from '../../stamp/staff.js';
import type { StampStore } from '../../stamp/store.js';
import { html, note, type Html } from './html.js';
import type { OverviewMaintenance } from './overview-maintenance.js';

const when = (iso: string) => new Date(iso).toLocaleString('el-GR', { timeZone: 'Europe/Athens' });
const cardWhen = (ms: number) => `${athensTime(ms).date} ${athensTime(ms).time.slice(0, 5)}`;

interface MissingProof {
  punchId: number;
  employeeId: number;
  branch: string;
  eventMs: number;
  filedMs: number;
  fType: string;
}

/** All filed cards lacking the second half of their proof, including those still in the early automatic tries. */
function missingProofs(db: StampStore): MissingProof[] {
  return db.prepare(`SELECT p.id, p.employee_id, p.branch, p.event_ms, p.f_type, min(a.finished_ms) AS filed_ms
    FROM punches p JOIN attempts a ON a.punch_id = p.id AND a.outcome = 'filed'
    WHERE NOT EXISTS (SELECT 1 FROM attempts a2 JOIN evidence e ON e.attempt_id = a2.id
                      WHERE a2.punch_id = p.id AND a2.outcome = 'filed' AND e.pdf IS NOT NULL)
    GROUP BY p.id ORDER BY p.event_ms, p.id`).all().map((r) => ({
      punchId: Number(r['id']), employeeId: Number(r['employee_id']), branch: String(r['branch']),
      eventMs: Number(r['event_ms']), filedMs: Number(r['filed_ms']), fType: String(r['f_type']),
    }));
}

/** The first screen is a local snapshot. The owner's existing actions remain on their protected pages. */
export function ownerOverview(o: {
  db: StampStore;
  nowMs: number;
  silentSince: number | undefined;
  heading: (branch: string) => string;
  maintenance: OverviewMaintenance;
}): Html {
  const today = athensTime(o.nowMs).date;
  const open = openPunches(o.db).map((punch) => ({ punch, state: stateOfPunch(o.db, punch, o.nowMs) }));
  const decisions = open.filter(({ state }) => state.kind === 'needs-human');
  const todayDecisions = decisions.filter(({ punch }) => athensTime(punch.eventMs).date === today).length;
  const earlierDecisions = decisions.length - todayDecisions;
  const retryProblems = open.filter(({ state }) => (state.kind === 'sending' || state.kind === 'sending-late') && (state.lastProblem !== undefined || (state.kind === 'sending' && state.overdue)));
  const onTheirWay = open.length - decisions.length;
  const proofs = missingProofs(o.db);
  const backup = o.maintenance.backup;
  const archive = o.maintenance.archive;
  return html`
<p class="hint">Η εικόνα στις ${cardWhen(o.nowMs)} (ώρα Ελλάδας). Ανανεώστε τη σελίδα για την τρέχουσα κατάσταση.</p>
<section aria-labelledby="submissions"><h3 id="submissions">Αποστολές καρτών — ${today}</h3>
${decisions.length === 0 ? note('ok', 'Καμία κάρτα δεν περιμένει απόφαση.') : note('bad', html`Σήμερα: ${todayDecisions} κάρτα/-ες χρειάζονται απόφαση.${earlierDecisions === 0 ? html`` : html`<br>Προηγούμενες ημέρες: ${earlierDecisions} κάρτα/-ες χρειάζονται απόφαση.`}`)}
${onTheirWay === 0 ? html`` : note('warn', `${onTheirWay} κάρτα/-ες περιμένουν επιβεβαίωση αποστολής. Η αποστολή ξαναδοκιμάζεται μέσα στο δικό της χρονικό όριο.`)}
${retryProblems.length === 0 ? html`` : html`<p>${retryProblems.length} κάρτα/-ες με πρόβλημα στην αυτόματη αποστολή:</p><ul>${retryProblems.map(({ punch, state }) => html`<li>${personById(o.db, punch.employeeId)?.displayName ?? '—'} — ${cardWhen(punch.eventMs)} — ${o.heading(punch.branch)}: ${'lastProblem' in state ? state.lastProblem?.message || 'Δεν έχει επιβεβαιωθεί η αποστολή.' : ''}</li>`)}</ul>`}
<p><a href="/queue">Δείτε τις εκκρεμότητες και αποφασίστε</a>.</p>
</section>
<section aria-labelledby="proofs"><h3 id="proofs">Αποδείξεις PDF</h3>
${proofs.length === 0 ? note('ok', 'Δεν λείπει απόδειξη PDF από τις κάρτες που στάλθηκαν.') : note('warn', `${proofs.length} κάρτα/-ες στάλθηκαν χωρίς να έχει ληφθεί ακόμη το PDF.`)}
<p><a href="/queue#proofs">Δείτε ποιες αποδείξεις λείπουν</a>.</p>
</section>
<section aria-labelledby="connection"><h3 id="connection">Σύνδεση με την ΕΡΓΑΝΗ</h3>
${o.silentSince === undefined ? note('ok', 'Δεν έχει παρατηρηθεί διακοπή 10 λεπτών από την εκκίνηση του προγράμματος.') : note('bad', `Ο υπολογιστής δεν φτάνει την ΕΡΓΑΝΗ από ${cardWhen(o.silentSince)}. Οι κάρτες κρατιούνται. Αν δεν σταλούν μέσα σε 15 λεπτά, ειδοποιήστε την Επιθεώρηση Εργασίας όταν αρχίζει και όταν τελειώνει το πρόβλημα.`)}
<p class="hint">Η παρακολούθηση ελέγχει μόνο αν απαντά η διεύθυνση της ΕΡΓΑΝΗ· δεν επιβεβαιώνει τον κωδικό ή τα δικαιώματα του χρήστη. Ο έλεγχος είναι μόνο ανάγνωση· τα περιορισμένα δικαιώματα επιβεβαιώνονται χωριστά στις ρυθμίσεις της ΕΡΓΑΝΗ.</p>
<p><a href="/check">Ελέγξτε τη σύνδεση κάθε παραρτήματος</a>.</p>
</section>
<section aria-labelledby="backup"><h3 id="backup">Αντίγραφο ασφαλείας</h3>
${backup === undefined ? note('warn', 'Δεν έχει γίνει ακόμη αντίγραφο ασφαλείας.') : backup.ok ? note(o.nowMs - Date.parse(backup.atIso) >= 86_400_000 ? 'warn' : 'ok', html`Τελευταίο αντίγραφο: ${when(backup.atIso)}.${o.nowMs - Date.parse(backup.atIso) >= 86_400_000 ? html`<br>Πέρασε μία ημέρα χωρίς νέο επιτυχημένο αντίγραφο.` : html``}`) : note('bad', `Το τελευταίο αντίγραφο απέτυχε (${when(backup.atIso)}): ${backup.problem ?? 'δεν καταγράφηκε αιτία'}`)}
<p><a href="/backup">Ελέγξτε τον φάκελο και πάρτε αντίγραφο τώρα</a>.</p>
</section>
<section aria-labelledby="archive"><h3 id="archive">Μηνιαίο αρχείο ΕΡΓΑΝΗ</h3>
${archive.problem === undefined ? html`
${archive.lastComplete === undefined ? note('warn', `Δεν έχει ολοκληρωθεί ακόμη μηνιαία ανάγνωση. Το αρχείο αρχίζει με τον μήνα ${archive.startsWith}.`) : note('ok', html`Τελευταία πλήρης ανάγνωση: ${archive.lastComplete.month} — ${o.heading(archive.lastComplete.branch)}, ${when(archive.lastComplete.finishedAt)}.`)}
${archive.problems.length === 0 ? html`` : html`${note('bad', 'Οι ακόλουθοι μήνες / παραρτήματα δεν έχουν ολοκληρωθεί στην τελευταία ανάγνωση:')}<ul>${archive.problems.map((p) => html`<li>${p.month} — ${o.heading(p.branch)}: ${p.message}</li>`)}</ul>`}
<p class="hint">Οι ενδείξεις αφορούν τις μηνιαίες αναγνώσεις ανά παράρτημα. Δεν υπάρχει ακόμη εδώ αποτέλεσμα ολόκληρης της ημερήσιας αρχειοθέτησης (π.χ. αν γράφτηκε η σελίδα σύγκρισης). Το αρχείο διαβάζεται ξανά αυτόματα κάθε μέρα.</p>` : note('bad', `Δεν διαβάστηκε η κατάσταση του μηνιαίου αρχείου: ${archive.problem}`)}
<p><a href="${archive.problem === undefined ? '/check' : '/backup'}">${archive.problem === undefined ? 'Ελέγξτε τη σύνδεση για τις μηνιαίες αναγνώσεις' : 'Δείτε τα αντίγραφα και τις οδηγίες επαναφοράς'}</a>.</p>
</section>`;
}

/** Destination of the overview's PDF action; read-only, with no retry button that could bypass the outbox. */
export function missingProofsPanel(db: StampStore, nowMs: number, heading: (branch: string) => string): Html {
  const missing = missingProofs(db);
  const afterTries = new Set(cardsMissingProof(db).map((p) => p.punchId));
  return html`<section aria-labelledby="proofs"><h3 id="proofs">Αποδείξεις PDF που λείπουν</h3>
${missing.length === 0 ? note('ok', 'Δεν λείπει απόδειξη PDF από τις κάρτες που στάλθηκαν.') : html`
<p>Η κάρτα στάλθηκε και κρατιέται ο αριθμός πρωτοκόλλου της. Το PDF ζητείται αυτόματα, αρχικά συχνότερα και μετά μία φορά την ημέρα, όσο η ΕΡΓΑΝΗ μπορεί να το διαθέτει. Μην ξαναχτυπήσετε κάρτα για να πάρετε απόδειξη.</p>
<ul>${missing.map((p) => html`<li>${personById(db, p.employeeId)?.displayName ?? '—'} — ${p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ'} ${cardWhen(p.eventMs)} — ${heading(p.branch)}: ${nowMs - p.filedMs > EVIDENCE_GIVE_UP_MS ? 'Η αυτόματη αναζήτηση σταμάτησε λόγω ηλικίας· ενημερώστε τον λογιστή για το PDF που λείπει.' : afterTries.has(p.punchId) ? 'Το PDF δεν έχει έρθει μετά τις αρχικές προσπάθειες· ζητείται ξανά κάθε μέρα.' : 'Αναμένεται το PDF· η αναζήτηση συνεχίζεται αυτόματα.'}</li>`)}</ul>`}
</section>`;
}
