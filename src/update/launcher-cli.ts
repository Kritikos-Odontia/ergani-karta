// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOwnerPage, runLauncher } from './launcher.js';
import { binaryName } from './versions.js';

/**
 * `launcher.mjs` — the launcher's own entry (launcher.ts), bundled on its own beside the installed runtime: it finds
 * the installed folder where it lies, and the runtime the installer carried in it (`node`, `node.exe`) — the one the
 * system starts it with.
 */
process.umask(0o077);
const install = dirname(fileURLToPath(import.meta.url));
const carried = join(install, binaryName());
const options = { install, runtime: existsSync(carried) ? carried : process.execPath, env: process.env };
const command = process.argv[2] ?? 'run';
const done = command === 'run' ? runLauncher(options) : command === 'open' ? openOwnerPage(options) : Promise.resolve(2);
done.then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
