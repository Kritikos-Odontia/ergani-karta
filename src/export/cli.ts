// SPDX-License-Identifier: EUPL-1.2
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openRecordStoreForReading } from '../records/store.js';
import { assertOutsideCodeFolders, newRequestFolder } from '../code-folders.js';
import { assertAfm, daysBetween, daysOfMonth, employeeRecord, employeesIn, monthComparison } from './model.js';
import { comparisonPage, employeeCsv, employeePage } from './render.js';

/**
 * THE EXPORT, run by hand — reads the record store, writes files, SENDS NOTHING.
 *
 *   ergani export employee --afm <ΑΦΜ> --from 2026-08-01 --to 2026-08-31 --out /abs/dir
 *   ergani export employee --all --from 2026-08-01 --to 2026-08-31 --out /abs/dir
 *   ergani export compare --month 2026-08 --out /abs/dir
 * (the record store is ERGANI_RECORDS_DB, as for the pull)
 *
 * `employee` writes, per employee, a page (`karta-<ΑΦΜ>-<from>-<to>.html`) and the same rows as CSV:
 * for a labour inspector, or for the employee — `--afm` gives ONE person their own data and nobody
 * else's; `--all` writes one pair per employee with a row in the range. `compare` writes the month's
 * comparison page (`sygkrisi-<YYYY-MM>.html`).
 *
 * ⛔ It opens the store READ-ONLY, needs no ΕΡΓΑΝΗ credential and makes no network call. No web server,
 * no login, no hosting: these are files, for the owner to hand over.
 * ⛔ It prints counts and paths only — never an ΑΦΜ or an hour.
 * ⓘ Folders are made 0700 and files 0600: they hold ΑΦΜ and working hours.
 */

export type ExportCommand = { store: string; out: string } & (
  | {
      kind: 'employee';
      /** One employee's ΑΦΜ, or `undefined` for every employee with a row in the range. */
      afm: string | undefined;
      from: string;
      to: string;
    }
  | { kind: 'compare'; month: string }
);

/**
 * The command line and environment, checked before anything is opened or written. Errors name the flag
 * or the variable, never its value — a value may be someone's ΑΦΜ.
 *   · The store: `ERGANI_RECORDS_DB`, an absolute path to a store that exists (as for the pull).
 *   · `--out`: absolute, and ⛔ NOT inside any code folder (`code-folders.ts`) — the files hold ΑΦΜ and working hours, and
 *     a file written into the working tree is one `git add` away from a pushed remote.
 */
export function exportCommand(argv: readonly string[], env: NodeJS.ProcessEnv): ExportCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      afm: { type: 'string' },
      all: { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      month: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });

  const store = env['ERGANI_RECORDS_DB'];
  if (store === undefined || store === '') throw new Error('ERGANI_RECORDS_DB is not set — it is the path of the record store file.');
  if (!isAbsolute(store)) throw new Error('ERGANI_RECORDS_DB must be an absolute path.');
  if (!existsSync(store)) throw new Error('There is no record store at ERGANI_RECORDS_DB. The export reads a store the pull has written.');

  const out = values.out;
  if (out === undefined || out === '') throw new Error('--out is required: the directory the files are written to.');
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  assertOutsideCodeFolders(out, '--out');

  const [kind, ...rest] = positionals;
  if (rest.length > 0) throw new Error('One command at a time: employee or compare.');
  if (kind === 'employee') {
    if (values.month !== undefined) throw new Error('employee takes --from and --to, not --month.');
    if ((values.afm !== undefined) === values.all) throw new Error('employee needs exactly one of --afm <ΑΦΜ> or --all.');
    if (values.afm !== undefined) assertAfm(values.afm);
    if (values.from === undefined || values.to === undefined) throw new Error('employee needs --from and --to, as YYYY-MM-DD.');
    daysBetween(values.from, values.to);
    return { kind, store, out, afm: values.afm, from: values.from, to: values.to };
  }
  if (kind === 'compare') {
    if (values.afm !== undefined || values.all || values.from !== undefined || values.to !== undefined) {
      throw new Error('compare takes --month only: it covers every employee of that month.');
    }
    if (values.month === undefined) throw new Error('compare needs --month, as YYYY-MM.');
    daysOfMonth(values.month);
    return { kind, store, out, month: values.month };
  }
  throw new Error('Say what to export: employee or compare.');
}

/**
 * Write what `command` asks for into a NEW folder inside `command.out` (`newRequestFolder`), from the store opened
 * read-only. `now` stamps the pages with when they were made — and is the day the staleness notice counts from.
 * Returns the files.
 */
export function runExport(command: ExportCommand, now: number): string[] {
  const db = openRecordStoreForReading(command.store);
  try {
    const requestName =
      command.kind === 'compare'
        ? `sygkrisi-${command.month}`
        // ⛔ No ΑΦΜ in the folder's name: the command prints it, and a name is seen by whoever can list the parent.
        : `${command.afm === undefined ? 'kartes-oloi' : 'karta'}-${command.from}-${command.to}`;
    const written: string[] = [];
    let folder: string | undefined;
    const write = (name: string, content: string) => {
      // A new folder per request, made at the first file: a hand-over copies it alone, never an earlier request's files.
      folder ??= newRequestFolder(command.out, requestName, now);
      const path = join(folder, name);
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
      written.push(path);
    };
    if (command.kind === 'compare') {
      write(`sygkrisi-${command.month}.html`, comparisonPage(monthComparison(db, command.month), now));
      return written;
    }
    const afms = command.afm === undefined ? employeesIn(db, command.from, command.to) : [command.afm];
    for (const afm of afms) {
      const record = employeeRecord(db, afm, command.from, command.to);
      const base = `karta-${afm}-${command.from}-${command.to}`;
      write(`${base}.html`, employeePage(record, now));
      write(`${base}.csv`, employeeCsv(record));
    }
    return written;
  } finally {
    db.close();
  }
}

export function runExportCli(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void): number {
  const command = exportCommand(argv, env);
  out('ΕΡΓΑΝΗ record export — reads the record store only, sends nothing');
  const files = runExport(command, Date.now());
  if (files.length === 0) {
    out('No employee has a stamp or declared-schedule row in that range: nothing was written.');
    return 0;
  }
  out(`Wrote ${files.length} file(s) to ${dirname(files[0]!)} — copy that folder alone.`);
  return 0;
}
