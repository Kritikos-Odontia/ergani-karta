// SPDX-License-Identifier: EUPL-1.2
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertOutsideCodeFolders } from '../code-folders.js';
import { daysBetween, daysOfMonth } from './model.js';
import { zipFiles } from './zip.js';
import { daysRead, heldStamps, openRecordStoreForReading, recordEmployer, type RecordStore } from '../records/store.js';
import { rowToPunch } from '../stamp/capture.js';
import { attemptsOf, stateOfPunch } from '../stamp/outbox.js';
import { instanceOf, storeBranches, type StampStore } from '../stamp/store.js';

export interface ExportPeriod { from: string; to: string }
export function accountantPeriod(input: { month?: string | undefined; from?: string | undefined; to?: string | undefined }, defaultMonth: string): ExportPeriod {
  if (input.from || input.to) {
    if (!input.from || !input.to) throw new Error('Δώστε και τις δύο ημερομηνίες.');
    if (Date.parse(`${input.to}T00:00Z`) - Date.parse(`${input.from}T00:00Z`) > 3660 * 86_400_000) throw new Error('Διαλέξτε περίοδο έως δέκα έτη.');
    daysBetween(input.from, input.to);
    return { from: input.from, to: input.to };
  }
  const days = daysOfMonth(input.month || defaultMonth);
  return { from: days[0]!, to: days.at(-1)! };
}

/** Quoted semicolon CSV + BOM + Excel delimiter hint. Text cannot become a spreadsheet formula. */
function csv(rows: readonly (readonly unknown[])[]): Buffer {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    const safe = /^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return Buffer.from(`\ufeffsep=;\r\n${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`);
}

const LOCAL = 'Τοπική καταγραφή';
const CONFIRMED = 'Επιβεβαιωμένο από τη νεότερη ανάγνωση ΕΡΓΑΝΗ';
const EARLIER = 'Παλαιότερη ανάγνωση — δεν επιστρέφεται πλέον';
const afmCell = (afm: string) => `'${afm}`; // preserve the leading zeros in Excel

/** Only saved records enter this function. There is no client, credential, PIN or network operation. */
export function accountantFiles(db: StampStore, archive: RecordStore | undefined, period: ExportPeriod, nowMs: number,
  branchName: (code: string) => string): Map<string, Buffer> {
  const instance = instanceOf(db);
  if (instance === undefined) throw new Error('Δεν βρέθηκε η ταυτότητα του αρχείου.');
  const environment = instance.realm === 'production' ? 'Παραγωγή' : 'ΔΟΚΙΜΗ — όχι πραγματική δήλωση';
  if (archive !== undefined) {
    if (recordEmployer(archive) !== instance.employerAfm) throw new Error('Το μηνιαίο αρχείο ανήκει σε άλλον εργοδότη.');
    const realms = archive.prepare('SELECT DISTINCT realm FROM pulls').all();
    if (realms.some((r) => r['realm'] !== instance.realm)) throw new Error('Το μηνιαίο αρχείο ανήκει σε άλλο περιβάλλον ΕΡΓΑΝΗ.');
  }
  const files = new Map<string, Buffer>();
  const headings = ['Τοπικός αριθμός κάρτας', 'Εργάσιμη ημέρα', 'Κωδικός παραρτήματος', 'Παράρτημα', 'ΑΦΜ', 'Επώνυμο κατά την κάρτα', 'Όνομα κατά την κάρτα', 'Κίνηση', 'Ώρα όπως χτυπήθηκε', 'Αποτέλεσμα', 'Αρ. πρωτοκόλλου', 'Τελευταίο πρόβλημα', 'Εκκρεμότητα λογιστή', 'Αποδεικτικά PDF', 'Πηγή', 'Περιβάλλον'];
  const movements: unknown[][] = [headings];
  const unresolved: unknown[][] = [headings];
  const results: unknown[][] = [['Τοπικός αριθμός κάρτας', 'Αριθμός προσπάθειας', 'Εργάσιμη ημέρα', 'Κωδικός παραρτήματος', 'ΑΦΜ', 'Προσπάθεια στις', 'Αποτέλεσμα', 'HTTP', 'Μήνυμα', 'Αρ. πρωτοκόλλου', 'Ημερομηνία δήλωσης', 'Αιτία εκπρόθεσμης', 'Πηγή', 'Περιβάλλον']];
  const punches = db.prepare('SELECT * FROM punches WHERE reference_date BETWEEN ? AND ? ORDER BY reference_date, event_ms, id').all(period.from, period.to).map(rowToPunch);
  for (const p of punches) {
    const state = stateOfPunch(db, p, nowMs);
    const attempts = attemptsOf(db, p.id);
    const proofs: string[] = [];
    for (const a of attempts) {
      results.push([p.id, a.id, p.referenceDate, p.branch, afmCell(p.afm), new Date(a.finishedMs).toISOString(),
        a.outcome === 'filed' ? 'Στάλθηκε — με πρωτόκολλο' : a.outcome === 'refused' ? 'Απορρίφθηκε' : 'Χωρίς επιβεβαίωση',
        a.httpStatus, a.message, a.protocol, a.submitDate, a.fAitiologia, LOCAL, environment]);
      if (a.outcome !== 'filed') continue;
      const evidence = db.prepare('SELECT id, pdf FROM evidence WHERE attempt_id = ? AND pdf IS NOT NULL ORDER BY id').all(a.id);
      for (const e of evidence) {
        const name = `proofs/card-${p.id}-attempt-${a.id}-proof-${e['id']}.pdf`;
        files.set(name, Buffer.from(e['pdf'] as Uint8Array));
        proofs.push(name);
      }
    }
    const last = attempts.at(-1);
    const status = state.kind === 'filed' ? (state.late ? 'Στάλθηκε εκπρόθεσμα — με πρωτόκολλο' : 'Στάλθηκε — με πρωτόκολλο')
      : state.kind === 'covered' ? `Καλύφθηκε αλλιώς κατά ${state.byLabel} — χωρίς επιβεβαίωση από εδώ`
      : state.kind === 'needs-human' ? 'Δεν επιβεβαιώθηκε — χρειάζεται απόφαση'
      : state.kind === 'sending-late' ? 'Σε εκπρόθεσμη αποστολή' : 'Σε αποστολή';
    const issue = state.kind === 'filed' ? '' : state.kind === 'covered' ? 'Ελέγξτε την κάλυψη με τον λογιστή / CardScanner' : 'Δεν υπάρχει επιβεβαιωμένη υποβολή από εδώ';
    const row = [p.id, p.referenceDate, p.branch, branchName(p.branch), afmCell(p.afm), p.surname, p.firstName,
      p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ', p.fDate, status, state.kind === 'filed' ? state.protocol : '',
      last?.outcome === 'filed' ? '' : last?.message ?? '', issue, proofs.join(' | ') || (state.kind === 'filed' ? 'Το PDF δεν έχει ληφθεί' : ''), LOCAL, environment];
    movements.push(row);
    if (state.kind !== 'filed') unresolved.push(row);
  }
  files.set('movements.csv', csv(movements));
  files.set('unresolved.csv', csv(unresolved));
  files.set('submission-results.csv', csv(results));
  const held = archive === undefined ? [] : heldStamps(archive, period.from, period.to);
  const reads = archive === undefined ? [] : daysRead(archive, period.from, period.to).filter((r) => r.service === 'EX_BASE_07');
  const readIndex = new Map(reads.map((r) => [`${r.branch}:${r.day}`, r]));
  files.set('ministry-readback.csv', csv([
    ['Εργάσιμη ημέρα', 'Κωδικός παραρτήματος', 'Παράρτημα', 'ΑΦΜ', 'Ημερομηνία ΕΡΓΑΝΗ', 'ΕΝΑΡΞΗ', 'ΛΗΞΗ', 'ΛΗΞΗ επόμενη ημέρα', 'Αντίγραφα στη νεότερη ανάγνωση', 'Νεότερη επιτυχής ανάγνωση στις', 'Πηγή', 'Περιβάλλον'],
    ...held.map((r) => [r.day, r.branch, branchName(r.branch), afmCell(r.afm), r.date, r.hourFrom, r.hourTo, r.endsNextDay ? 'Ναι' : 'Όχι',
      r.inLatestRead, readIndex.get(`${r.branch}:${r.day}`)?.readAt ?? '', r.inLatestRead > 0 ? CONFIRMED : EARLIER, environment]),
  ]));
  const branches = [...new Set([...storeBranches(db), ...reads.map((r) => r.branch), ...held.map((r) => r.branch)])];
  files.set('readback-coverage.csv', csv([
    ['Ημέρα', 'Κωδικός παραρτήματος', 'Παράρτημα', 'Κατάσταση ανάγνωσης', 'Ανάγνωση στις', 'Πηγή', 'Περιβάλλον'],
    ...daysBetween(period.from, period.to).flatMap((day) => branches.map((branch) => {
      const read = readIndex.get(`${branch}:${day}`);
      return [day, branch, branchName(branch), read === undefined ? 'Δεν έχει αναγνωστεί — δεν γνωρίζουμε τι κρατά η ΕΡΓΑΝΗ' : 'Υπάρχει αποθηκευμένη ανάγνωση', read?.readAt ?? '', read === undefined ? LOCAL : 'Ανάγνωση ΕΡΓΑΝΗ', environment];
    })),
  ]));
  files.set('README.txt', Buffer.from(`Κάρτα Εργασίας — αρχείο για τον λογιστή\nΠερίοδος εργάσιμης ημέρας: ${period.from} έως ${period.to}\nΣυντάχθηκε: ${new Date(nowMs).toISOString()}\nΠεριβάλλον: ${environment}\n\n` +
    'Ανοίξτε τα CSV με Excel (UTF-8, διαχωριστικό ;). Τα ΑΦΜ προστατεύονται ως κείμενο για να κρατούν τα αρχικά μηδενικά.\n' +
    'movements.csv: οι τοπικές κάρτες, το αποτέλεσμα και οι διαδρομές των PDF στον φάκελο proofs. Η ώρα περιέχει τη ζώνη Αθήνας. Μια ΛΗΞΗ μετά τα μεσάνυχτα ανήκει στην εργάσιμη ημέρα της ΕΝΑΡΞΗΣ.\n' +
    'submission-results.csv: κάθε προσπάθεια υποβολής, μαζί με το πρωτόκολλο ή το μήνυμα αποτυχίας.\nunresolved.csv: κάθε κάρτα χωρίς επιβεβαιωμένη υποβολή από εδώ, ακόμη κι αν σημειώθηκε ότι καλύφθηκε αλλιώς.\n' +
    'ministry-readback.csv: τα διαστήματα που κρατά το μηνιαίο αρχείο, με σαφή διάκριση ανάμεσα στη νεότερη ανάγνωση και όσα δεν επιστρέφονται πλέον. Περιλαμβάνει και κάρτες από άλλον τρόπο, π.χ. CardScanner.\n' +
    'readback-coverage.csv: ποιες ημέρες / παραρτήματα έχουν αναγνωστεί. Μια ημέρα χωρίς ανάγνωση δεν σημαίνει ημέρα χωρίς κάρτα.\n' +
    (archive === undefined ? 'Δεν υπάρχει μηνιαίο αρχείο: η εξαγωγή περιέχει μόνο τις τοπικές κάρτες.\n' : '') +
    'Το πρωτόκολλο επιβεβαιώνει την υποβολή, όχι την παρουσία στη μηνιαία ανάγνωση. Τα τοπικά και τα μηνιαία στοιχεία παραμένουν χωριστά· δεν γίνεται αυτόματη αντιστοίχιση ή συμπέρασμα για τη μισθοδοσία. Η εξαγωγή δεν ζητά νέα ανάγνωση και δεν δηλώνει τίποτα στην ΕΡΓΑΝΗ.\n' +
    'Το ZIP και ο φάκελος έχουν ΑΦΜ και ώρες εργασίας. Φυλάξτε τα όπως το αρχείο του ιατρείου και παραδώστε τα μόνο στον λογιστή σας. Δεν περιέχουν ρυθμίσεις σύνδεσης ή PIN.\n'));
  return files;
}

export function writeAccountantExport(o: { db: StampStore; recordsPath: string; out: string; period: ExportPeriod; nowMs: number; branchName: (code: string) => string }): { folder: string; zip: string } {
  // Revalidate the public boundary before any reads or directory creation.
  accountantPeriod(o.period, '');
  assertOutsideCodeFolders(o.out, 'The accountant export');
  let archive: RecordStore | undefined;
  let files: Map<string, Buffer>;
  try {
    if (existsSync(o.recordsPath)) { archive = openRecordStoreForReading(o.recordsPath); archive.exec('BEGIN'); }
    o.db.exec('BEGIN');
    try { files = accountantFiles(o.db, archive, o.period, o.nowMs, o.branchName); }
    finally { o.db.exec('ROLLBACK'); }
  } finally { archive?.close(); }
  const zipped = zipFiles(files!);
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(o.out, `accountant-${o.period.from}-${o.period.to}-`));
  for (const [name, bytes] of files!) {
    const target = join(folder, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  }
  const zip = join(folder, 'accountant.zip');
  writeFileSync(zip, zipped, { mode: 0o600, flag: 'wx' });
  return { folder, zip };
}
