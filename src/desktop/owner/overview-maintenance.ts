// SPDX-License-Identifier: EUPL-1.2
import type { ErganiRealm } from '../../config.js';
import { monthsBefore } from '../../records/daily.js';
import { openRecordStoreForReading, pullLog, recordEmployer, type PullLogEntry } from '../../records/store.js';
import { athensTime } from '../../stamp/athens.js';
import type { DesktopPaths } from '../paths.js';
import { readDesktopState, type DesktopState } from '../state.js';

export interface OverviewMaintenance {
  backup: DesktopState['lastBackup'];
  archive: {
    startsWith: string;
    lastComplete: PullLogEntry | undefined;
    problems: Array<{ month: string; branch: string; message: string }>;
    problem?: string;
  };
}

/**
 * ERGANI-READY INTEGRATION SEAM — replace this reader with ready's persisted backup/archive status after it merges.
 * On the pre-ready schema, desktop.json knows only the latest backup attempt; pulls knows individual branch/month
 * reads, NOT an entire daily run (in particular, it cannot see a comparison-page write failure). Keep that boundary
 * explicit on screen. A GET only reads local facts: no network, no archive run, no creating or migrating a store.
 */
export function readOverviewMaintenance(o: {
  paths: DesktopPaths;
  nowMs: number;
  archiveFrom: string;
  branches: readonly string[];
  employerAfm: string;
  realm: ErganiRealm;
}): OverviewMaintenance {
  const result: OverviewMaintenance = {
    backup: readDesktopState(o.paths.desktop)?.lastBackup,
    archive: { startsWith: o.archiveFrom, lastComplete: undefined, problems: [] },
  };
  try {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.archiveFrom)) throw new Error('δεν έχει οριστεί έγκυρος πρώτος μήνας του αρχείου');
    const db = openRecordStoreForReading(o.paths.recordsDb);
    try {
      if (recordEmployer(db) !== o.employerAfm) throw new Error('το μηνιαίο αρχείο δεν ανήκει σε αυτόν τον εργοδότη');
      const pulls = pullLog(db);
      if (pulls.some((p) => p.realm !== o.realm)) throw new Error('το μηνιαίο αρχείο ανήκει σε διαφορετικό περιβάλλον ΕΡΓΑΝΗ');
      result.archive.lastComplete = pulls.filter((p) => p.outcome === 'complete' && o.branches.includes(p.branch)).at(-1);
      const thisMonth = athensTime(o.nowMs).date.slice(0, 7);
      const months = [5, 4, 3, 2, 1].map((back) => monthsBefore(thisMonth, back)).filter((m) => m >= o.archiveFrom);
      for (const month of months) {
        for (const branch of o.branches) {
          const last = pulls.filter((p) => p.month === month && p.branch === branch).at(-1);
          if (last === undefined || last.outcome !== 'complete') {
            result.archive.problems.push({ month, branch, message: last === undefined ? 'Δεν έχει ολοκληρωθεί ανάγνωση.' : 'Η τελευταία ανάγνωση δεν ολοκληρώθηκε.' });
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    result.archive.problem = error instanceof Error ? error.message : 'άγνωστο σφάλμα';
  }
  return result;
}
