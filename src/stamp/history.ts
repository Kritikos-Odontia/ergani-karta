// SPDX-License-Identifier: EUPL-1.2
import { WORK_CARD_DELAY_REASON_LABELS } from '../ergani/types.js';
import { rowToPunch } from './capture.js';
import { attemptsOf, decisionsOf, stateOfPunch } from './outbox.js';
import type { Person } from './staff.js';
import type { StampStore } from './store.js';

/**
 * ONE PERSON'S OWN CARDS — what they stamped here and what became of each, with ΕΡΓΑΝΗ's protocol numbers.
 *
 * ⚠ A LEGAL REQUIREMENT, NOT A FEATURE (docs/RULES.md rule 2): the employer keeps card data five years (retain ten) and
 * each employee may see their own (ΥΑ 113169/2023). This store is the system of record of what we filed, so the
 * answer comes from here — not from the monthly ΕΡΓΑΝΗ copy, which is a month behind and holds only what ΕΡΓΑΝΗ kept.
 * The owner writes it on request (`admin.ts history`): a Greek page that prints to paper or PDF from any browser,
 * and a spreadsheet file of the same rows. Nothing about anyone else is in it.
 */

export interface HistoryRow {
  /** The working day, `YYYY-MM-DD`. */
  day: string;
  /** Where it was stamped — the branch's name; empty for an employer with one branch. */
  branch: string;
  type: 'ΕΝΑΡΞΗ' | 'ΛΗΞΗ';
  /** `f_date` exactly as filed. */
  at: string;
  /** What became of the card, in Greek. */
  status: string;
  protocol: string;
}

export function historyOf(
  db: StampStore,
  employeeId: number,
  from: string,
  to: string,
  nowMs: number,
  branchName: (code: string) => string = () => '',
): HistoryRow[] {
  const punches = db
    .prepare('SELECT * FROM punches WHERE employee_id = ? AND reference_date BETWEEN ? AND ? ORDER BY event_ms, id')
    .all(employeeId, from, to)
    .map(rowToPunch);
  return punches.map((p) => {
    const state = stateOfPunch(db, p, nowMs);
    let status: string;
    let protocol = '';
    if (state.kind === 'filed') {
      protocol = state.protocol;
      const reason = attemptsOf(db, p.id).find((a) => a.outcome === 'filed')?.fAitiologia;
      status = state.late
        ? `Στάλθηκε εκπρόθεσμα (αιτία ${reason}: ${reason ? WORK_CARD_DELAY_REASON_LABELS[reason as keyof typeof WORK_CARD_DELAY_REASON_LABELS] : ''}) — ${state.submitDate}`
        : `Στάλθηκε — ${state.submitDate}`;
    } else if (state.kind === 'covered') {
      const by = decisionsOf(db, p.id).find((d) => d.kind === 'covered')?.byLabel ?? '';
      status = `Δεν στάλθηκε από εδώ — καλύφθηκε αλλιώς (CardScanner ή λογιστής), κατά ${by}`;
    } else if (state.kind === 'needs-human') {
      status = 'ΔΕΝ στάλθηκε — εκκρεμεί απόφαση';
    } else {
      status = 'Σε αποστολή';
    }
    return {
      day: p.referenceDate,
      branch: branchName(p.branch),
      type: p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ',
      at: p.fDate,
      status,
      protocol,
    };
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Whether the rows name a branch at all: the column is shown only for an employer with more than one. */
const withBranch = (rows: readonly HistoryRow[]) => rows.some((r) => r.branch !== '');

export function historyHtml(person: Person, rows: readonly HistoryRow[], from: string, to: string, label: string, madeAt: string): string {
  const branchCol = withBranch(rows);
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.day)}</td>${branchCol ? `<td>${escapeHtml(r.branch)}</td>` : ''}<td>${r.type}</td><td>${escapeHtml(r.at)}</td><td>${escapeHtml(r.protocol)}</td><td>${escapeHtml(r.status)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="el"><head><meta charset="utf-8"><title>Κάρτα εργασίας — ${escapeHtml(person.surname)} ${escapeHtml(person.firstName)}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px;text-align:left}</style>
</head><body>
<h1>Κάρτα Εργασίας — οι κινήσεις μου</h1>
<p>${escapeHtml(label)} · ${escapeHtml(person.surname)} ${escapeHtml(person.firstName)} · ΑΦΜ ${escapeHtml(person.afm)}</p>
<p>Περίοδος ${escapeHtml(from)} έως ${escapeHtml(to)} · ${rows.length} κινήσεις · συντάχθηκε ${escapeHtml(madeAt)}</p>
<p>Κάθε κίνηση χτυπήθηκε από τον ίδιο/την ίδια στη σελίδα της υποδοχής, με προσωπικό κωδικό, και στάλθηκε στην ΕΡΓΑΝΗ· ο αριθμός πρωτοκόλλου είναι η απόδειξη της ΕΡΓΑΝΗΣ.</p>
<table><thead><tr><th>Εργάσιμη ημέρα</th>${branchCol ? '<th>Παράρτημα</th>' : ''}<th>Κίνηση</th><th>Ώρα (όπως δηλώθηκε)</th><th>Αρ. πρωτοκόλλου</th><th>Τι έγινε</th></tr></thead>
<tbody>
${body}
</tbody></table>
</body></html>
`;
}

/** A cell for a spreadsheet: quoted, and never read as a formula. */
function cell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function historyCsv(rows: readonly HistoryRow[]): string {
  const branchCol = withBranch(rows);
  const columns = (r: HistoryRow) => [r.day, ...(branchCol ? [r.branch] : []), r.type, r.at, r.protocol, r.status];
  const head = ['Εργάσιμη ημέρα', ...(branchCol ? ['Παράρτημα'] : []), 'Κίνηση', 'Ώρα', 'Αρ. πρωτοκόλλου', 'Τι έγινε'].map(cell).join(',');
  return `﻿${[head, ...rows.map((r) => columns(r).map(cell).join(','))].join('\r\n')}\r\n`;
}
