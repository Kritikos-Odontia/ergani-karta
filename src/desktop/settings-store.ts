// SPDX-License-Identifier: EUPL-1.2
import { loadEmployerConfig } from '../config.js';
import { inTransaction } from '../records/store.js';
import { loadStampSettings } from '../stamp/config.js';
import { addBranch, assertBranches, openStampStore, storeBranches } from '../stamp/store.js';

/**
 * A settings file rename and a store commit cannot share a transaction. After an interrupted desktop branch add,
 * complete only the missing additions from the validated file. Missing old branches are always an error: no removal.
 * This also accepts the existing CLI/settings-file route on the desktop, without a second branch command.
 */
export function ensureConfiguredBranches(path: string, env: NodeJS.ProcessEnv, nowIso: string): void {
  const employer = loadEmployerConfig(env);
  const settings = loadStampSettings(env);
  const configured = employer.branches.map((b) => b.branchCode);
  const db = openStampStore(path, { name: settings.instance, realm: employer.erganiRealm, employerAfm: employer.employerAfm });
  try {
    const held = storeBranches(db);
    if (held.some((code) => !configured.includes(code))) assertBranches(db, configured);
    inTransaction(db, () => {
      for (const code of configured.filter((b) => !held.includes(b))) {
        addBranch(db, code, nowIso);
        db.prepare('INSERT INTO settings_events (at, kind, subject, detail, by) VALUES (?, ?, ?, ?, ?)')
          .run(nowIso, 'branch-added', code, JSON.stringify({ label: settings.branches.find((b) => b.code === code)!.label }), 'desktop settings recovery');
      }
    });
  } finally { db.close(); }
}
