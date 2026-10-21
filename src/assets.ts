// SPDX-License-Identifier: EUPL-1.2
import { readFileSync, readdirSync } from 'node:fs';

/**
 * THE FILES THE PROGRAM READS BESIDE ITS CODE — the two stores' numbered SQL migrations, and the maker's mark. Read
 * from the source tree here. The desktop bundle (scripts/build.ts) puts in place of this module one that carries
 * them inside the single file, so that a version is one file and nothing it needs can go missing beside it.
 * ⚠ The bundle's replacement exports these same three names; a test runs the bundle from an empty folder.
 */
export interface AssetFile {
  name: string;
  text: string;
}

function sqlFiles(relative: string): AssetFile[] {
  const dir = new URL(relative, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));
}

export const recordMigrationFiles = (): AssetFile[] => sqlFiles('./records/migrations/');
export const stampMigrationFiles = (): AssetFile[] => sqlFiles('./stamp/migrations/');
export const makerMark = (): string => readFileSync(new URL('./brand/odontia-mark.svg', import.meta.url), 'utf8');
