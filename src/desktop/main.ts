// SPDX-License-Identifier: EUPL-1.2
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { makerMark } from '../assets.js';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEmployerConfig } from '../config.js';
import { runArchive } from '../records/cli.js';
import { claimRecordStore, openRecordStore } from '../records/store.js';
import { loadStampSettings } from '../stamp/config.js';
import { runStampService } from '../stamp/main.js';
import { initStampStore } from '../stamp/store.js';
import { backupAndRecord, backupDue } from './backup.js';
import { GUIDE_PAGE } from './owner/guide.js';
import { note, page } from './owner/html.js';
import { ownerPages } from './owner/pages.js';
import { openInBrowser } from './open.js';
import { createOwnerServer, type OwnerPage } from './owner/server.js';
import { dataDir, desktopPaths, ownerPort, type DesktopPaths } from './paths.js';
import { serviceEnv } from './settings-file.js';
import { readDesktopState } from './state.js';
import { Updater } from '../update/updater.js';
import { commitProbation, readPending } from '../update/versions.js';
import { cardsOnTheirWay } from '../stamp/outbox.js';
import { VERSION } from '../version.js';

/**
 * `ergani desktop` — THE DESKTOP PROGRAM: everything in one process on the practice's own computer.
 *   · the owner's pages on 127.0.0.1 (`OWNER_PORT`, paths.ts): the setup on first run, then the owner's pages (owner/);
 *   · once set up: the stamping service — the staff page, the outbox, the alarms — exactly as `ergani stamp`, and the
 *     monthly archive's daily run exactly as `ergani archive`, with this computer's settings (settings-file.ts);
 *   · it opens the owner's page in the browser when it starts (`--no-browser`: not);
 *   · run by the launcher (`KARTA_LAUNCHER=1`, update/launcher.ts): the updater (update/updater.ts), and the probation
 *     of a version just switched to — it passes when the stamping service is built, right before its outbox starts;
 *     if it does not, the program ends and the launcher undoes the switch (update/versions.ts).
 * ⓘ The services are the gated ones, unchanged: this file only gives them their settings and starts them.
 */
export async function runDesktop(argv: readonly string[], outside: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { 'no-browser': { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
  const root = dataDir(outside);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = desktopPaths(root);
  const now = Date.now;
  const log = (line: string) => {
    const stamped = `${new Date(now()).toISOString()} ${line}`;
    console.log(stamped);
    try {
      appendFileSync(paths.log, `${stamped}\n`, { mode: 0o600 });
    } catch {
      /* the console still has it */
    }
  };

  const launched = outside['KARTA_LAUNCHER'] === '1';
  const pending = launched ? readPending(paths.versions) : undefined;
  let onProbation = pending?.to === VERSION;
  const passProbation = () => {
    if (!onProbation || pending === undefined) return;
    // The record store opens (and takes this version's migrations) too, before anything is filed.
    openRecordStore(paths.recordsDb).close();
    commitProbation(paths.versions, pending);
    onProbation = false;
    log(`update ${pending.from} → ${VERSION}: passed its checks`);
  };

  let pages: ReadonlyMap<string, OwnerPage> | undefined;
  let stamping: Awaited<ReturnType<typeof runStampService>> | undefined;
  let updater: Updater | undefined;
  const start = async () => {
    const env = serviceEnv(paths, outside);
    ensureStores(paths, env, new Date(now()).toISOString());
    stamping = await runStampService(env, { onSignals: false, beforeStart: passProbation });
    // The daily run loops for as long as the program runs; a failure of one run is its own (records/cli.ts).
    runArchive([], env, (line) => log(`archive: ${line}`)).catch((error: unknown) =>
      log(`archive stopped — ${error instanceof Error ? error.message : String(error)}`),
    );
    const running = stamping;
    if (launched) {
      updater = new Updater({
        paths,
        env: outside,
        now,
        log,
        quiet: (t, sinceMs) => quietForUpdate(paths, t, sinceMs),
        stopServices: async () => {
          server.close();
          await running.stop();
        },
        exit: (code) => process.exit(code),
      });
      updater.start();
    }
    pages = ownerPages({ paths, env, now, log, erganiSilentSince: (t) => running.silentSinceMs(t), updater });
    // The daily backup: looked at every hour, run when a day has passed since the last good one (backup.ts).
    setInterval(() => {
      const state = readDesktopState(paths.desktop);
      if (state !== undefined && backupDue(state, now())) backupAndRecord(paths, now(), log);
    }, 3_600_000).unref();
  };

  const server = createOwnerServer({
    paths,
    now,
    log,
    onSetup: start,
    pages: () => pages,
    guide: GUIDE_PAGE,
    mark: makerMark(),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ownerPort(outside), '127.0.0.1', resolve);
  });
  const ownerUrl = `http://127.0.0.1:${ownerPort(outside)}/`;
  log(`owner pages on ${ownerUrl}`);

  // Stopping (the system shutting down, an update): the owner pages close, the stamping service finishes the card it
  // is sending and closes its store, then the process ends — the archive's loop with it.
  const shutdown = () => {
    log('stopping');
    server.close();
    void (stamping?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  if (existsSync(paths.settings) && existsSync(paths.desktop)) {
    try {
      await start();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      log(`did not start — ${why}`);
      if (onProbation) {
        log(`update to ${VERSION} failed its checks — ending, so the launcher goes back`);
        process.exit(1);
      }
      // The owner pages stay up and say so, instead of «starting» for ever.
      const failed = () => ({
        status: 503,
        body: page('Δεν ξεκίνησε', note('bad', `Το πρόγραμμα δεν ξεκίνησε: ${why}`), { nav: false }),
      });
      pages = new Map([['/', failed]]);
    }
  } else {
    passProbation(); // not set up yet: nothing to check
  }
  if (!values['no-browser']) openInBrowser(ownerUrl, log);
}

/**
 * Whether an update may stop the program now: no card on its way to ΕΡΓΑΝΗ (its 15 minutes run), and no stamp within
 * `sinceMs` (the night's hour of quiet; 0 for the owner's button).
 */
export function quietForUpdate(paths: DesktopPaths, nowMs: number, sinceMs: number): boolean {
  if (!existsSync(paths.stampDb)) return true;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(paths.stampDb, { readOnly: true });
  try {
    if (cardsOnTheirWay(db, nowMs) > 0) return false;
    const last = db.prepare('SELECT MAX(event_ms) AS last FROM punches').get() as { last: number | null };
    return sinceMs === 0 || last.last === null || nowMs - last.last >= sinceMs;
  } finally {
    db.close();
  }
}

/** Make whichever store is missing — the first start after setup; never touches one that exists. */
export function ensureStores(paths: DesktopPaths, env: NodeJS.ProcessEnv, nowIso: string): void {
  const ergani = loadEmployerConfig(env);
  const stamp = loadStampSettings(env);
  if (!existsSync(paths.stampDb)) {
    mkdirSync(dirname(paths.stampDb), { recursive: true, mode: 0o700 });
    initStampStore(
      paths.stampDb,
      { name: stamp.instance, realm: ergani.erganiRealm, employerAfm: ergani.employerAfm },
      ergani.branches.map((b) => b.branchCode),
      nowIso,
    ).close();
  }
  if (!existsSync(paths.recordsDb)) {
    mkdirSync(dirname(paths.recordsDb), { recursive: true, mode: 0o700 });
    const db = openRecordStore(paths.recordsDb);
    try {
      claimRecordStore(db, ergani.employerAfm, nowIso);
    } finally {
      db.close();
    }
  }
}
