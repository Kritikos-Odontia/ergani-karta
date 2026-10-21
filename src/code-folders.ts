// SPDX-License-Identifier: EUPL-1.2
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * ⛔ NOTHING THAT HOLDS A PERSON'S DATA IS WRITTEN INSIDE A CODE FOLDER — ANY code folder on the machine,
 * not only this one (docs/DECISIONS.md). The record store and the export's files hold ΑΦΜ and
 * working hours, and a file in a git working copy is one `git add` away from a pushed remote. Knowing only
 * the copy the code runs from was not enough: a second copy (a worktree, a clone) could write into the
 * main one. `.gitignore`'s `*.sqlite` is a backstop for one spelling; this is the
 * control, for any.
 *
 * A code folder is a folder with a `.git` entry — a directory in a main checkout, a file in a worktree —
 * or anything below one. The Desktop, Documents, a backup drive and a server's data folders hold none.
 *
 * Judged on where the path LEADS: its deepest existing part is resolved by the system, so links are
 * followed, and asking for `.git` goes through the disk itself — its own sense of capitals (the Mac's
 * ignores them) and its other names for the same folder (on a Mac, `/System/Volumes/Data/…` is `/…`).
 * ⛔ `.` and `..` are refused: in the part that does not exist yet, the system would take them only as it
 * creates it, so where the path leads could not be judged beforehand. A trailing `/` is dropped before
 * judging: with it, the system follows a last link before it can be judged, and a link to nothing, or to
 * a file, would read as absent and be stepped past.
 * ⓘ What is written INTO an accepted directory is not re-checked name by name: a link planted there under
 * a generated file name takes someone with access to the machine, not a mistyped path.
 */
export function assertOutsideCodeFolders(path: string, what: string): void {
  if (path.split(sep).some((part) => part === '.' || part === '..')) {
    throw new Error(`${what} must be written without «.» or «..» in it, so that where it leads can be checked.`);
  }
  let plain = path;
  while (plain.length > 1 && plain.endsWith(sep)) plain = plain.slice(0, -1);
  for (let dir = existingPartOf(plain, what); ; dir = dirname(dir)) {
    if (exists(join(dir, '.git'))) {
      throw new Error(
        `${what} is inside a code folder (a git working copy). It holds ΑΦΜ and working hours and must never ` +
          'end up in git — put it outside every code folder: the Desktop, Documents, a backup drive.',
      );
    }
    if (dirname(dir) === dir) return;
  }
}

/** The deepest part of `path` that exists, as the system resolves it. A link to nothing is refused. */
function existingPartOf(path: string, what: string): string {
  let head = path;
  while (!exists(head) && dirname(head) !== head) head = dirname(head);
  try {
    return realpathSync(head);
  } catch {
    throw new Error(`${what} runs through a link to something that does not exist, so where it leads cannot be checked.`);
  }
}

/** Present on disk — a link counts even when its target is missing. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A NEW folder, inside `parent`, for one request's files (one person's record, one month's comparison): the owner
 * copies that folder alone and hands it over, so it can never carry an earlier request's files — another person's
 * record. Named `<name>-<UTC time to the second>` and ⛔ never reused: an existing one is an error, not a merge.
 * `parent` is checked by the caller (`assertOutsideCodeFolders`) before this runs.
 */
export function newRequestFolder(parent: string, name: string, now: number): string {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = join(parent, `${name}-${new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, '')}`);
  mkdirSync(folder, { mode: 0o700 });
  return folder;
}
