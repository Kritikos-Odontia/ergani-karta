// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import type { DesktopPaths } from './paths.js';

/**
 * THE SETTINGS FILE, read the way Docker Compose reads it — `KEY=value` lines; blank lines and lines starting with `#`
 * skipped; the value is everything after the first `=`, unchanged. The guided setup (setup/settings.ts) refuses every
 * value this reading would change (quotes, `$`, a backslash, a line break, ` #`), so what was answered is what is read.
 */
export function parseSettings(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error('the settings file has a line that is not KEY=value — write it again with the setup.');
    values[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return values;
}

/**
 * The environment the gated services run with on this computer: the employer's settings, plus where this program
 * keeps its stores and on which address the staff page listens (the private address chosen at setup).
 * ⛔ Nothing else from the process's own environment reaches the services, except the one test hatch the services
 * already guard: `ERGANI_BASE_URL`, which config.ts accepts only for a local fake (loopback or `.invalid`). With it,
 * the realm is the fake's own («local») and the file's realm lines are dropped; the stores remember the realm they
 * were made in, so stores made against the fake never open against ΕΡΓΑΝΗ, nor the other way round.
 */
export function serviceEnv(paths: DesktopPaths, outside: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const settings = parseSettings(readFileSync(paths.settings, 'utf8'));
  const testHatch = outside['ERGANI_BASE_URL'];
  if (testHatch !== undefined) {
    delete settings['ERGANI_ENV'];
    delete settings['ERGANI_CONFIRM_PRODUCTION'];
  }
  return {
    ...settings,
    ...(testHatch === undefined ? {} : { ERGANI_BASE_URL: testHatch }),
    STAMP_DB: paths.stampDb,
    ERGANI_RECORDS_DB: paths.recordsDb,
    ERGANI_EXPORTS_DIR: paths.exports,
    STAMP_LISTEN_HOST: settings['ERGANI_BIND_ADDRESS'] ?? '127.0.0.1',
    STAMP_PORT: settings['ERGANI_PORT'] ?? '8880',
  };
}
