// SPDX-License-Identifier: EUPL-1.2
import { runExportCli } from './export/cli.js';
import { runArchive, runPull } from './records/cli.js';
import { runDesktop } from './desktop/main.js';
import { runSetupCli } from './setup/cli.js';
import { adminCommand } from './stamp/admin.js';
import { runStampService } from './stamp/main.js';

/**
 * `ergani` — the one command, for every part of the package (docs/ADMIN.md):
 *
 *   ergani desktop [--no-browser]     the desktop program: everything in one process, the owner's pages on 127.0.0.1
 *   ergani setup [--out <file>]       the guided first setup: writes the employer's settings file
 *   ergani stamp                      the stamping service — every branch's reception page and the outbox
 *   ergani admin <command> …          the owner's tool: staff, devices, the queue, closed days, check
 *   ergani check [--branch N]         READ ONLY: each branch's login, its forms, today's schedule (= admin check)
 *   ergani archive [--once]           the monthly archive's daily run (READ ONLY)
 *   ergani pull …                     one month of the archive by hand, or --init-store (READ ONLY)
 *   ergani export …                   a person's own records, or a month's comparison page (reads the record only)
 *
 * ⓘ Every part reads its settings from the environment (the employer's settings file, handed in by Docker Compose).
 * Errors are printed as one line, never with the settings they came from.
 */
async function main(argv: readonly string[]): Promise<number> {
  // Every file this process makes — the two stores and their journals, the exports — is the owner's alone, also when
  // it runs outside Docker, where the stores' folders may not be private (the pages hold ΑΦΜ, the store PIN hashes).
  process.umask(0o077);
  const [command, ...rest] = argv;
  const out = (line: string) => console.log(line);
  switch (command) {
    case 'stamp':
      await runStampService();
      return 0;
    case 'desktop':
      await runDesktop(rest);
      return 0;
    case 'admin':
      return adminCommand(rest, process.env, { now: Date.now, out });
    case 'check':
      return adminCommand(['check', ...rest], process.env, { now: Date.now, out });
    case 'archive':
      return runArchive(rest, process.env, (line) => console.log(`[archive] ${line}`));
    case 'pull':
      return runPull(rest, process.env, out);
    case 'export':
      return runExportCli(rest, process.env, out);
    case 'setup':
      return runSetupCli(rest);
    default:
      out('ergani — ψηφιακή κάρτα εργασίας. Commands: setup · stamp · admin · check · archive · pull · export');
      out('See docs/ADMIN.md.');
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    // ⓘ `stamp` and `archive` keep running on their own timers; only a command that finished sets the exit code.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
