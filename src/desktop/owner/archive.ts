// SPDX-License-Identifier: EUPL-1.2
import { DatabaseSync } from 'node:sqlite';
import { readArchiveStatus } from '../../records/status.js';
import { monthsBefore } from '../../records/daily.js';
import { athensTime } from '../../stamp/athens.js';
import { html, note, type Html } from './html.js';

/** Read the local record only. Include never-read months even after they leave the ministry's readable window. */
export function archiveOverview(store: string, from: string, branches: readonly string[], nowMs: number, runtimeFailed = false): Html {
  const status = readArchiveStatus(store);
  const gaps = new Map((status?.incomplete ?? []).map((p) => [`${p.month}/${p.branch}`, p]));
  try {
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      const last = monthsBefore(athensTime(nowMs).date.slice(0, 7), 1);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from)) throw new Error();
      for (let month = last; month >= from; month = monthsBefore(month, 1)) {
        for (const branch of branches) {
          const latest = db.prepare('SELECT outcome FROM pulls WHERE month = ? AND branch = ? ORDER BY id DESC LIMIT 1').get(month, branch);
          if (latest?.['outcome'] !== 'complete') gaps.set(`${month}/${branch}`, { month, branch });
        }
      }
    } finally { db.close(); }
  } catch {
    return note('bad', 'Το μηνιαίο αρχείο δεν διαβάζεται. Ελέγξτε το αρχείο καταγραφής· η πληρότητά του δεν έχει επιβεβαιωθεί.');
  }
  const when = (iso: string) => new Date(iso).toLocaleString('el-GR', { timeZone: 'Europe/Athens' });
  return html`<h3>Μηνιαίο αρχείο από την ΕΡΓΑΝΗ</h3>
${status?.lastGood === undefined ? note('warn', `Δεν έχει επιβεβαιωθεί ακόμη πλήρες μηνιαίο αρχείο (από ${from}· ο τρέχων μήνας διαβάζεται από τον επόμενο).`) : note(nowMs - Date.parse(status.lastGood) > 36 * 3_600_000 ? 'warn' : 'ok', `Τελευταίο πλήρες μηνιαίο αρχείο: ${when(status.lastGood)}.${nowMs - Date.parse(status.lastGood) > 36 * 3_600_000 ? ' Δεν έχει επιβεβαιωθεί ξανά για πάνω από 36 ώρες.' : ''}`)}
${runtimeFailed || status?.kind === 'failed' ? note('bad', 'Ο τελευταίος έλεγχος του μηνιαίου αρχείου απέτυχε. Η επόμενη προσπάθεια γίνεται στον καθημερινό έλεγχο· δείτε το αρχείο καταγραφής.') : status?.kind === 'down' ? note('bad', 'Το μηνιαίο αρχείο απάντησε χωρίς κάρτες ενώ υπάρχει δηλωμένο ωράριο. Ελέγξτε το με τον λογιστή.') : html``}
${gaps.size === 0 ? html`` : note('warn', html`Μήνες / παραρτήματα που χρειάζονται έλεγχο ή δεν έχουν ολοκληρωθεί: ${[...gaps.values()].sort((a, b) => a.month.localeCompare(b.month) || a.branch.localeCompare(b.branch)).map((p) => html`<br>${p.month} — παράρτημα ${p.branch}`)}`)}
${(status?.pages.length ?? 0) === 0 ? html`` : note('bad', `Σελίδες που δεν γράφτηκαν: ${status!.pages.join(', ')}.`)}`;
}
