// SPDX-License-Identifier: EUPL-1.2
import { heartbeatSender } from '../heartbeat.js';
import { Alarms } from './alarms.js';
import { branchHeading, loadEverything } from './config.js';
import { filingClient } from './deadline.js';
import { namelessSender, ntfySender, type PushSender } from './notify.js';
import { Outbox } from './outbox.js';
import { branchRetired } from './branch-status.js';
import { ReachWatch } from './reach.js';
import { HEALTHY_PASS_MS, createStampServer } from './server.js';
import { StoreLock } from './store-lock.js';
import { openStampStore, type Instance } from './store.js';

/**
 * THE STAMPING SERVICE — one employer's reception pages (one per branch) and its outbox, in one process
 * (docs/INSTALL.md).
 *
 * ── ⛔ EACH ΕΡΓΑΝΗ LOGIN HAS ONE SEAM (docs/RULES.md rule 7) ─────────────────────────────────────────
 * Each branch's login is read once, here, into its `Config` (a `Secret`), and handed to the ONE client that files that
 * branch's cards. No route, no page and no log line ever sees it; the client exposes it only inside its sign-in.
 *
 * ⚠⚠ In `production` every card is a real, legally-binding declaration about a named person. The first real filing
 * is a step of its own, on a real shift (docs/INSTALL.md, «Η πρώτη πραγματική κάρτα»), never a test.
 */
export async function runStampService(
  env: NodeJS.ProcessEnv = process.env,
  options: { onSignals?: boolean; beforeStart?: () => void; pushes?: PushSender; listenRetryMs?: number; log?: (line: string) => void } = {},
): Promise<{ stop: () => Promise<void>; silentSinceMs: (nowMs: number) => number | undefined; pageProblem: () => string | undefined }> {
  const { ergani, stamp } = loadEverything(env);
  const instance: Instance = { name: stamp.instance, realm: ergani.erganiRealm, employerAfm: ergani.employerAfm };
  const codes = ergani.branches.map((b) => b.branchCode);
  // ⛔ ONE OUTBOX PER STORE (store-lock.ts): taken before the store is opened, held for as long as this process lives.
  const lock = StoreLock.take(stamp.dbPath);
  if (lock === undefined) {
    throw new Error(
      'another stamping service is already running on this store. Refusing to start a second one: two would send the ' +
        'same cards twice, in any order.',
    );
  }
  const db = openStampStore(stamp.dbPath, instance, codes);
  const now = Date.now;
  // The console (`ergani stamp`, Docker's log), or the program's own log (the desktop program, whose console nobody sees).
  const log = options.log ?? ((line: string) => console.log(`[${stamp.instance}] ${line}`));

  const clients = new Map(ergani.branches.map((config) => [config.branchCode, filingClient(config, now)] as const));
  const outbox = new Outbox({ db, clients, employerAfm: ergani.employerAfm, now, log });
  const readsSchedule = (code: string) => !branchRetired(db, code) && stamp.branches.find((b) => b.code === code)?.scheduleFromErgani === true;
  const alarms = new Alarms({
    db,
    branches: stamp.branches.filter((b) => !branchRetired(db, b.code)).map((b) => ({ code: b.code, label: b.label, fromSchedule: b.scheduleFromErgani })),
    readers: new Map([...clients].filter(([code]) => readsSchedule(code))),
    // The employer's own server (pushes with names), or the easy mode (nameless, ntfy.sh), or the desktop program's
    // own choice (`pushes`, its «Ειδοποιήσεις» page) — in that order.
    send:
      stamp.ntfy !== undefined
        ? ntfySender(stamp.ntfy.url, stamp.ntfy.token)
        : stamp.easyTopic !== undefined
          ? namelessSender(stamp.easyTopic)
          : options.pushes,
    now,
    title: `ΕΡΓΑΝΗ — ${stamp.label}`,
    log,
  });
  // «Δεν φτάνω την ΕΡΓΑΝΗ» (reach.ts): one look every two minutes at ΕΡΓΑΝΗ's address, no login.
  const reach = new ReachWatch({ baseUrl: ergani.branches[0]!.erganiBaseUrl, now });
  const server = createStampServer({
    db,
    hooks: { outbox, warnings: (t) => [...alarms.deskWarnings(t), ...reach.warnings(t)] },
    instance: stamp.instance,
    branches: stamp.branches.map((b) => ({ code: b.code, heading: branchHeading(stamp, b.code), inspectorateEmail: b.inspectorateEmail })),
    cookieSecure: stamp.cookieSecure,
    now,
    log,
  });

  log(
    `starting — realm ${instance.realm}${instance.realm === 'production' ? ' (THE REAL REGISTER: every card is a real declaration)' : ''}, ` +
      `branch${codes.length > 1 ? 'es' : ''} ${codes.map((c) => (readsSchedule(c) ? c : `${c} (no schedule read)`)).join(', ')}`,
  );
  // The desktop program's probation after an update (update/versions.ts) ends here: everything is built and nothing has
  // been sent or stamped yet. A throw stops the start, with the store untouched by this run.
  try {
    options.beforeStart?.();
  } catch (error) {
    db.close();
    lock.release();
    throw error;
  }
  outbox.start();
  alarms.start();
  reach.start();
  // The page's address may be missing at the start — the Wi-Fi not up yet at sign-in, a new address from the router —
  // or its port held by another program. That never ends the service (the outbox and the alarms go on): it is said
  // (`pageProblem`, the error's code) and tried again every half minute until the page opens.
  let pageProblem: string | undefined;
  let relisten: NodeJS.Timeout | undefined;
  let stopped = false;
  const retryMs = options.listenRetryMs ?? 30_000;
  const listen = () => server.listen(stamp.port, stamp.listenHost);
  server.on('listening', () => {
    pageProblem = undefined;
    log(`page on ${stamp.listenHost}:${stamp.port}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    const code = error.code ?? error.message;
    if (server.listening || stopped) return void log(`page: ${code}`);
    if (pageProblem !== code) log(`page: not on ${stamp.listenHost}:${stamp.port} (${code}) — trying again every ${Math.round(retryMs / 1000)} s`);
    pageProblem = code;
    relisten = setTimeout(listen, retryMs);
  });
  listen();

  // The monitor hears «up» each minute only while the outbox is passing; a stuck or dead service goes silent.
  const beat = stamp.heartbeatUrl === undefined ? undefined : heartbeatSender(stamp.heartbeatUrl);
  const beating =
    beat === undefined
      ? undefined
      : setInterval(() => {
          const pass = outbox.lastPassMs;
          if (pass === undefined || now() - pass >= HEALTHY_PASS_MS) return;
          beat('up', 'OK').catch((error: unknown) => log(`heartbeat: ${error instanceof Error ? error.message : 'failed'}`));
        }, 60_000);

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      log('stopping');
      stopped = true;
      if (relisten !== undefined) clearTimeout(relisten);
      if (beating !== undefined) clearInterval(beating);
      reach.stop();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await Promise.all([outbox.stop(), alarms.stop(), closed]);
      } finally {
        db.close();
        lock.release();
      }
    })());
  // `ergani stamp` stops on the system's signals; a program that runs the service among others (the desktop one)
  // stops it itself, in its own order.
  if (options.onSignals !== false) {
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
  }
  return { stop, silentSinceMs: (t) => reach.silentSinceMs(t), pageProblem: () => pageProblem };
}
