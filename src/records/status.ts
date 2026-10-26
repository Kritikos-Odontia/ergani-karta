// SPDX-License-Identifier: EUPL-1.2
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
export interface ArchiveStatus {
  atIso: string;
  kind: 'up' | 'down' | 'failed';
  lastGood?: string | undefined;
  incomplete: Array<{ month: string; branch: string }>;
  pages: string[];
}

export interface ArchiveRun {
  kind: 'up' | 'down' | 'failed';
  incomplete?: Array<{ month: string; branch: string }>;
  pages?: string[];
  waiting?: boolean;
}
const Status = z.object({ atIso: z.string(), kind: z.enum(['up', 'down', 'failed']), lastGood: z.string().optional(), incomplete: z.array(z.object({ month: z.string(), branch: z.string() })), pages: z.array(z.string()) });
const statusPath = (store: string) => `${store}.archive-status.json`;

/** Safe operational metadata only: never ministry error prose, names, credentials or identifiers. */
export function readArchiveStatus(store: string): ArchiveStatus | undefined {
  if (!existsSync(statusPath(store))) return undefined;
  try { return Status.parse(JSON.parse(readFileSync(statusPath(store), 'utf8'))); }
  catch { return { atIso: '', kind: 'failed', incomplete: [], pages: [] }; }
}

export function recordArchiveStatus(store: string, outcome: ArchiveRun, nowMs: number): void {
  const prior = readArchiveStatus(store);
  const atIso = new Date(nowMs).toISOString();
  const lastGood = outcome.kind === 'up' && !outcome.waiting ? atIso : prior?.lastGood;
  const state: ArchiveStatus = {
    atIso, kind: outcome.kind, ...(lastGood === undefined ? {} : { lastGood }),
    incomplete: outcome.incomplete ?? (outcome.kind === 'failed' ? prior?.incomplete ?? [] : []),
    pages: outcome.pages ?? (outcome.kind === 'failed' ? prior?.pages ?? [] : []),
  };
  writeFileSync(`${statusPath(store)}.new`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(`${statusPath(store)}.new`, statusPath(store));
}
