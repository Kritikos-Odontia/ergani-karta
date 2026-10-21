// SPDX-License-Identifier: EUPL-1.2
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopPaths } from '../desktop/paths.js';

/**
 * THE VERSIONS FOLDER — `<data folder>/versions/`, the only ground the updater (updater.ts, inside the program) and
 * the launcher (launcher.ts, outside it) share:
 *   <x.y.z>/          one version: `node` (`node.exe`), `app.mjs`, `version.json` {version, node}
 *   <x.y.z>.partial/  a version being written; never run; removed when found
 *   current           one line: the version the launcher runs
 *   previous          one line: the version before it — where a `current` that keeps dying falls back to
 *   pending.json      during a switch: `to` is ON PROBATION — it has filed nothing yet, so it can be undone
 *   rollback.json     the last switch undone by itself — the owner's home page says so
 * Plain files, not symbolic links (Windows). Every write goes through a temporary file renamed into place.
 *
 * ── THE SWITCH ────────────────────────────────────────────────────────────────────────────────────────
 * The running version stops its stamping (the card on its way finishes), copies both stores into `<to>/.snapshot/`,
 * writes `pending.json`, sets `current = to`, and exits with `RESTART`. The launcher starts `to`. On probation `to`
 * migrates the stores and checks itself BEFORE its outbox or staff page start; healthy, it sets `previous = from` and
 * removes `pending.json` (`commitProbation`) — only then does it file anything. Any other end of `to` while
 * `pending.json` names it — an error, a crash, two minutes without becoming healthy — and the launcher puts the
 * snapshot back (`to` filed nothing, so nothing is lost) and runs `from` again.
 */
export const RESTART = 75;
export const PROBATION_MS = 2 * 60_000;

const Version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
export const VersionFile = z.object({ version: Version, node: Version }).strict();
export const Pending = z.object({ from: Version, to: Version, snapshot: z.string().optional(), atIso: z.string() }).strict();
export type Pending = z.infer<typeof Pending>;
export const Rollback = z.object({ failed: Version, back: Version, atIso: z.string(), why: z.string() }).strict();
export type Rollback = z.infer<typeof Rollback>;

export const versionDir = (versions: string, version: string) => join(versions, version);
export const binaryName = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'node.exe' : 'node');

function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.new`, text, { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

export function readMark(versions: string, mark: 'current' | 'previous'): string | undefined {
  const path = join(versions, mark);
  if (!existsSync(path)) return undefined;
  const parsed = Version.safeParse(readFileSync(path, 'utf8').trim());
  return parsed.success ? parsed.data : undefined;
}

export function writeMark(versions: string, mark: 'current' | 'previous', version: string): void {
  writeWhole(join(versions, mark), `${Version.parse(version)}\n`);
}

export function clearMark(versions: string, mark: 'current' | 'previous'): void {
  rmSync(join(versions, mark), { force: true });
}

export function readPending(versions: string): Pending | undefined {
  const path = join(versions, 'pending.json');
  return existsSync(path) ? Pending.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

export function writePending(versions: string, pending: Pending): void {
  writeWhole(join(versions, 'pending.json'), `${JSON.stringify(Pending.parse(pending))}\n`);
}

export function readRollback(versions: string): Rollback | undefined {
  const path = join(versions, 'rollback.json');
  if (!existsSync(path)) return undefined;
  const parsed = Rollback.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

export function writeRollback(versions: string, rollback: Rollback): void {
  writeWhole(join(versions, 'rollback.json'), `${JSON.stringify(Rollback.parse(rollback))}\n`);
}

/** A version folder that is whole: its runtime, its app and its `version.json` naming it. */
export function versionReady(versions: string, version: string): boolean {
  const dir = versionDir(versions, version);
  try {
    const file = VersionFile.parse(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')));
    return file.version === version && existsSync(join(dir, binaryName())) && existsSync(join(dir, 'app.mjs'));
  } catch {
    return false;
  }
}

/**
 * Probation passed: `to` is the version, `from` the one to fall back to, and the switch is over. Older versions and
 * their snapshots are removed; `from` and `to` stay.
 */
export function commitProbation(versions: string, pending: Pending): void {
  writeMark(versions, 'previous', pending.from);
  rmSync(join(versions, 'pending.json'), { force: true });
  rmSync(join(versionDir(versions, pending.to), '.snapshot'), { recursive: true, force: true });
  for (const name of readdirSync(versions, { withFileTypes: true })) {
    if (name.isDirectory() && name.name !== pending.from && name.name !== pending.to) {
      rmSync(join(versions, name.name), { recursive: true, force: true });
    }
  }
}

const STORES = (paths: DesktopPaths) =>
  [
    [paths.stampDb, 'stamp.sqlite'],
    [paths.recordsDb, 'records.sqlite'],
  ] as const;

/**
 * A consistent copy of both stores into `into` (SQLite's `VACUUM INTO`: a whole file, never half a write). Taken
 * after the stamping has stopped, so it holds every card. A store that does not exist yet is not copied — and
 * `restoreSnapshot` then removes what probation made.
 */
export function snapshotStores(paths: DesktopPaths, into: string): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true, mode: 0o700 });
  for (const [store, name] of STORES(paths)) {
    if (!existsSync(store)) continue;
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      db.prepare('VACUUM INTO ?').run(join(into, name));
    } finally {
      db.close();
    }
  }
  writeFileSync(join(into, 'complete'), '', { mode: 0o600 });
}

/**
 * Put the stores back as they were at the switch. ⚠ Only for a version that never left probation: it filed nothing,
 * so the copy holds everything that happened. A store's rollback journal goes too — it belongs to the version undone.
 */
export function restoreSnapshot(paths: DesktopPaths, snapshot: string): void {
  if (!existsSync(join(snapshot, 'complete'))) throw new Error(`the snapshot ${snapshot} is not complete`);
  for (const [store, name] of STORES(paths)) {
    rmSync(`${store}-journal`, { force: true });
    const copy = join(snapshot, name);
    if (existsSync(copy)) {
      copyFileSync(copy, `${store}.restore`);
      renameSync(`${store}.restore`, store);
    } else {
      rmSync(store, { force: true });
    }
  }
}
