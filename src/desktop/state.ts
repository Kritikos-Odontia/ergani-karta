// SPDX-License-Identifier: EUPL-1.2
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * WHAT ONLY THE DESKTOP PROGRAM KEEPS (`desktop.json`, 0600, beside the settings): the owner's password hash, where
 * backups go, whether updates install by themselves at night, and the last backup. Written whole, through a temporary
 * file renamed into place, so a crash never leaves half a file.
 */
/** The updater's notes (update/updater.ts): the last daily check, and the last install that did not happen. */
export const UpdateRecord = z.object({
  checkedIso: z.string(),
  ok: z.boolean(),
  /** A newer release whose signature and signed list verified. */
  available: z.string().optional(),
  problem: z.string().optional(),
  installProblem: z.object({ atIso: z.string(), problem: z.string() }).optional(),
});
export type UpdateRecord = z.infer<typeof UpdateRecord>;

export const DesktopState = z.object({
  ownerPassword: z.string().startsWith('scrypt$'),
  /** The folder backups are copied to — a USB stick or the Dropbox folder. Unset: no backup yet (the home page says so). */
  backupFolder: z.string().optional(),
  /** His ruling: ON from the start; the owner may switch it off. */
  nightUpdates: z.boolean().default(true),
  lastBackup: z
    .object({ atIso: z.string(), ok: z.boolean(), problem: z.string().optional() })
    .optional(),
  update: UpdateRecord.optional(),
  /** The easy phone alerts: the random ntfy.sh topic (stamp/notify.ts — nameless pushes only). Unset: off. */
  alerts: z.object({ topic: z.string() }).optional(),
  /** When the two stores were first made. From then on a missing store is a lost record, never made again empty. */
  storesSince: z.string().optional(),
});
export type DesktopState = z.infer<typeof DesktopState>;

export function readDesktopState(path: string): DesktopState | undefined {
  if (!existsSync(path)) return undefined;
  return DesktopState.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeDesktopState(path: string, state: DesktopState): void {
  const temporary = `${path}.new`;
  writeFileSync(temporary, `${JSON.stringify(DesktopState.parse(state), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
