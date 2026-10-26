// SPDX-License-Identifier: EUPL-1.2
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { makerMark } from '../assets.js';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEmployerConfig } from '../config.js';
import { runArchive } from '../records/cli.js';
import { claimRecordStore, openRecordStore } from '../records/store.js';
import { loadStampSettings } from '../stamp/config.js';
import { runStampService } from '../stamp/main.js';
import { initStampStore } from '../stamp/store.js';
import { BACKUPS, backupAndRecord, backupDue } from './backup.js';
import { GUIDE_PAGE } from './owner/guide.js';
import { html, note, page, type Html } from './owner/html.js';
import { ownerPages } from './owner/pages.js';
import { openInBrowser } from './open.js';
import { createOwnerServer, type OwnerPage } from './owner/server.js';
import { dataDir, desktopPaths, ownerPort, type DesktopPaths } from './paths.js';
import { ensureConfiguredBranches } from './settings-store.js';
import { serviceEnv } from './settings-file.js';
import { readDesktopState, writeDesktopState } from './state.js';
import { Updater } from '../update/updater.js';
import { PORT_TAKEN, commitProbation, readPending } from '../update/versions.js';
import { cardsOnTheirWay } from '../stamp/outbox.js';
import { namelessSender, type PushSender } from '../stamp/notify.js';
import { VERSION } from '../version.js';

/**
 * `ergani desktop` — THE DESKTOP PROGRAM: everything in one process on the practice's own computer.
 *   · the owner's pages on 127.0.0.1 (`OWNER_PORT`, paths.ts): the setup on first run, then the owner's pages (owner/);
 *   · once set up: the stamping service — the staff page, the outbox, the alarms — exactly as `ergani stamp`, and the
 *     monthly archive's daily run exactly as `ergani archive`, with this computer's settings (settings-file.ts);
 *   · it opens the owner's page in the browser when it starts (`--no-browser`: not); `--no-open` opens nothing at all,
 *     not even an employee's records folder for the owner (the tests; a computer without a screen);
 *   · run by the launcher (`KARTA_LAUNCHER=1`, update/launcher.ts): the updater (update/updater.ts), and the probation
 *     of a version just switched to — it passes when the stamping service is built, right before its outbox starts;
 *     if it does not, the program ends and the launcher undoes the switch (update/versions.ts).
 * ⓘ The services are the gated ones, unchanged: this file only gives them their settings and starts them.
 */
export async function runDesktop(argv: readonly string[], outside: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { 'no-browser': { type: 'boolean', default: false }, 'no-open': { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
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
    // The record store opens (and takes this version's migrations) too, before anything is filed. Not set up yet,
    // there is none to open.
    if (existsSync(paths.recordsDb)) openRecordStore(paths.recordsDb).close();
    commitProbation(paths.versions, pending);
    onProbation = false;
    log(`update ${pending.from} → ${VERSION}: passed its checks`);
  };

  let pages: ReadonlyMap<string, OwnerPage> | undefined;
  let stamping: Awaited<ReturnType<typeof runStampService>> | undefined;
  let updater: Updater | undefined;
  const start = async () => {
    const env = serviceEnv(paths, outside);
    const nowIso = new Date(now()).toISOString();
    const state = readDesktopState(paths.desktop);
    ensureStores(paths, env, nowIso, state?.storesSince !== undefined);
    if (state !== undefined && state.storesSince === undefined) writeDesktopState(paths.desktop, { ...state, storesSince: nowIso });
    // The easy phone alerts, as the owner's «Ειδοποιήσεις» page sets them now (nameless: stamp/notify.ts). Against the
    // local stand-in for ΕΡΓΑΝΗ (the tests' hatch) the alarms never leave the computer; the page's ΔΟΚΙΜΗ still does.
    const standIn = loadEmployerConfig(env).erganiRealm === 'local';
    const pushes: PushSender = async (push, key) => {
      const topic = readDesktopState(paths.desktop)?.alerts?.topic;
      if (topic === undefined || standIn) return 'off';
      await namelessSender(topic)(push, key);
    };
    stamping = await runStampService(env, { onSignals: false, beforeStart: passProbation, pushes, log: (line) => log(`stamp: ${line}`) });
    // The daily run loops for as long as the program runs; a failure of one run is its own (records/cli.ts).
    runArchive([], env, (line) => log(`archive: ${line}`)).catch((error: unknown) =>
      log(`archive stopped — ${error instanceof Error ? error.message : String(error)}`),
    );
    const reloadSettings = async () => {
      // One outbox at a time: finish its active send, release its lock, then use the new logins and headings.
      await stamping?.stop();
      Object.assign(env, serviceEnv(paths, outside));
      stamping = await runStampService(env, { onSignals: false, pushes, log: (line) => log(`stamp: ${line}`) });
    };
    if (launched) {
      updater = new Updater({
        paths,
        env: outside,
        now,
        log,
        quiet: (t, sinceMs) => quietForUpdate(paths, t, sinceMs),
        stopServices: async () => {
          server.close();
          await stamping?.stop();
        },
        exit: (code) => process.exit(code),
      });
      updater.start();
    }
    pages = ownerPages({ paths, env, now, log, reloadSettings, erganiSilentSince: (t) => stamping?.silentSinceMs(t), staffPageProblem: () => stamping?.pageProblem(), updater, openFolders: !values['no-open'] });
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(ownerPort(outside), '127.0.0.1', resolve);
    });
  } catch (error) {
    if (!launched || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    // Before any store is opened: the launcher tries again later and blames no version (versions.ts PORT_TAKEN).
    log(`the owner pages' port ${ownerPort(outside)} is taken — by another copy of the program or another program`);
    process.exit(PORT_TAKEN);
  }
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
        body: page('Δεν ξεκίνησε', error instanceof StoreMissing ? restoreSteps(paths, error.missing) : note('bad', `Το πρόγραμμα δεν ξεκίνησε: ${why}`), { nav: false }),
      });
      pages = new Map([['/', failed]]);
    }
  } else {
    passProbation(); // not set up yet: nothing to check
  }
  if (!values['no-browser'] && !values['no-open']) openInBrowser(ownerUrl, log);
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
    db.exec('PRAGMA busy_timeout = 5000');
    if (cardsOnTheirWay(db, nowMs) > 0) return false;
    const last = db.prepare('SELECT MAX(event_ms) AS last FROM punches').get() as { last: number | null };
    return sinceMs === 0 || last.last === null || nowMs - last.last >= sinceMs;
  } finally {
    db.close();
  }
}

/** A store the program made is gone: the employer's record is lost until it is restored from a backup. */
export class StoreMissing extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`λείπει το αρχείο ${missing.join(', ')} — επαναφέρετέ το από το τελευταίο αντίγραφο ασφαλείας`);
  }
}

/**
 * The restore, on the page the owner sees when a store is missing — the only page served then (the owner's pages need
 * the stores): which file, from which backup folder, into which folder, and the restart that starts the program again.
 */
export function restoreSteps(paths: DesktopPaths, missing: readonly string[]): Html {
  const folder = readDesktopState(paths.desktop)?.backupFolder;
  const copies = missing.map((store) => html`<li>αντιγράψτε το <code>${basename(store)}</code> στον φάκελο <code>${dirname(store)}</code>·</li>`);
  return html`${note('bad', html`Λείπει ${missing.length > 1 ? 'τα αρχεία' : 'το αρχείο'} του εργοδότη: ${missing.map((store) => html`<code>${store}</code> `)}. Το πρόγραμμα δεν ξεκινά με άδειο αρχείο, για να μη χαθεί η καταγραφή χωρίς να το δείτε.`)}
<h2>Επαναφορά από αντίγραφο ασφαλείας</h2>
<ol>
<li>${folder === undefined ? html`Δεν είχε οριστεί φάκελος αντιγράφων. Αν έχετε κρατήσει αντίγραφο αλλού, ανοίξτε το.` : html`Ανοίξτε τον φάκελο <code>${join(folder, BACKUPS)}</code> (συνδέστε πρώτα το USB, αν είναι εκεί) και μέσα του το νεότερο <code>karta-…</code>.`}</li>
${copies}
<li>επανεκκινήστε τον υπολογιστή: το πρόγραμμα ξεκινά μόνο του με το αρχείο που επαναφέρατε.</li>
</ol>
<p class="hint">Ό,τι χτυπήθηκε μετά το αντίγραφο λείπει από αυτό· το μηνιαίο αντίγραφο της ΕΡΓΑΝΗ ξαναδιαβάζεται μόνο του.
⚠ Μια κάρτα που φαίνεται μετά την επαναφορά να περιμένει απόφαση μπορεί να είχε ήδη σταλεί: δείτε πρώτα στην ΕΡΓΑΝΗ αν
υπάρχει, πριν επιλέξετε «εκπρόθεσμα» — αλλιώς θα δηλωθεί δεύτερη φορά.</p>`;
}

/**
 * Make the stores on the first start after setup; never touch one that exists. ⛔ Once made (`established`), a missing
 * store is the employer's record lost — the program refuses to start and says to restore it from a backup, instead of
 * carrying on with an empty one that hides the loss.
 */
export function ensureStores(paths: DesktopPaths, env: NodeJS.ProcessEnv, nowIso: string, established: boolean): void {
  if (established) {
    const missing = [paths.stampDb, paths.recordsDb].filter((store) => !existsSync(store));
    if (missing.length > 0) throw new StoreMissing(missing);
    ensureConfiguredBranches(paths.stampDb, env, nowIso);
    return;
  }
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
  ensureConfiguredBranches(paths.stampDb, env, nowIso);
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
