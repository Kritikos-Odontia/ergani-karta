// SPDX-License-Identifier: EUPL-1.2
import type { StampStore } from './store.js';

/** Retirement is an additional fact, never removal of the branch or its cards. */
export function branchRetired(db: StampStore, code: string): boolean {
  return db.prepare("SELECT 1 FROM settings_events WHERE kind = 'branch-retired' AND subject = ? LIMIT 1").get(code) !== undefined;
}
