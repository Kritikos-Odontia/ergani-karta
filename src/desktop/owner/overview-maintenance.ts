// SPDX-License-Identifier: EUPL-1.2
import type { ErganiRealm } from '../../config.js';
import { openRecordStoreForReading, pullLog, recordEmployer, type PullLogEntry } from '../../records/store.js';
import { readArchiveStatus, type ArchiveStatus } from '../../records/status.js';
import { athensTime } from '../../stamp/athens.js';
import type { DesktopPaths } from '../paths.js';
import { readDesktopState, type DesktopState } from '../state.js';

export interface OverviewMaintenance {
  backup: DesktopState['lastBackup'];
  archive: {
    startsWith: string;
    lastComplete: PullLogEntry | undefined;
    run: ArchiveStatus | undefined;
    runtimeFailed: boolean;
    problems: Array<{ month: string; branch: string; message: string }>;
    problem?: string;
  };
}

/**
 * The overview's ONE maintenance reader: complete-backup attempts from desktop.json, whole daily archive outcomes
 * from records/status.ts, and coverage from the append-only pulls. An individual pull is a fallback for installations
 * awaiting their first daily status, never a claimed whole-run success. A GET reads local facts only: no network,
 * archive run, store creation or migration. Runtime failure survives a failed status write (e.g. a full disk).
 */
export function readOverviewMaintenance(o: {
  paths: DesktopPaths;
  nowMs: number;
  archiveFrom: string;
  branches: readonly string[];
  employerAfm: string;
  realm: ErganiRealm;
  archiveFailed?: boolean;
}): OverviewMaintenance {
  const result: OverviewMaintenance = {
    backup: readDesktopState(o.paths.desktop)?.lastBackup,
    archive: { startsWith: o.archiveFrom, lastComplete: undefined, run: undefined, runtimeFailed: o.archiveFailed ?? false, problems: [] },
  };
  try {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.archiveFrom)) throw new Error('δεν έχει οριστεί έγκυρος πρώτος μήνας του αρχείου');
    const db = openRecordStoreForReading(o.paths.recordsDb);
    try {
      if (recordEmployer(db) !== o.employerAfm) throw new Error('το μηνιαίο αρχείο δεν ανήκει σε αυτόν τον εργοδότη');
      const pulls = pullLog(db);
      if (pulls.some((p) => p.realm !== o.realm)) throw new Error('το μηνιαίο αρχείο ανήκει σε διαφορετικό περιβάλλον ΕΡΓΑΝΗ');
      result.archive.run = readArchiveStatus(o.paths.recordsDb);
      result.archive.lastComplete = pulls.filter((p) => p.outcome === 'complete' && o.branches.includes(p.branch)).at(-1);
      const thisMonth = athensTime(o.nowMs).date.slice(0, 7);
      const indexOf = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
      const problems = new Map<string, OverviewMaintenance['archive']['problems'][number]>();
      // Keep never-complete months visible even after they leave the ministry's readable window. Month arithmetic
      // avoids Date.UTC's special treatment of years 00–99, including for a mistaken but well-formed setting.
      for (let index = indexOf(o.archiveFrom); index < indexOf(thisMonth); index++) {
        const month = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
        for (const branch of o.branches) {
          const last = pulls.filter((p) => p.month === month && p.branch === branch).at(-1);
          if (last === undefined || last.outcome !== 'complete') {
            problems.set(`${month}/${branch}`, { month, branch, message: last === undefined ? 'Δεν έχει ολοκληρωθεί ανάγνωση.' : 'Η τελευταία ανάγνωση δεν ολοκληρώθηκε.' });
          }
        }
      }
      for (const gap of result.archive.run?.incomplete ?? []) {
        if (!problems.has(`${gap.month}/${gap.branch}`)) problems.set(`${gap.month}/${gap.branch}`, { ...gap, message: 'Χρειάζεται έλεγχος του αποτελέσματος της ημερήσιας αρχειοθέτησης.' });
      }
      result.archive.problems = [...problems.values()].sort((a, b) => a.month.localeCompare(b.month) || a.branch.localeCompare(b.branch));
    } finally {
      db.close();
    }
  } catch (error) {
    result.archive.problem = error instanceof Error ? error.message : 'άγνωστο σφάλμα';
  }
  return result;
}
