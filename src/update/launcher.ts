// SPDX-License-Identifier: EUPL-1.2
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openInBrowser } from '../desktop/open.js';
import { dataDir, desktopPaths, ownerPort, type DesktopPaths } from '../desktop/paths.js';
import { StoreLock } from '../stamp/store-lock.js';
import { newer } from './release.js';
import {
  PORT_TAKEN,
  PROBATION_MS,
  RESTART,
  VersionFile,
  binaryName,
  clearMark,
  readMark,
  readPending,
  readRollback,
  restoreSnapshot,
  snapshotStores,
  versionDir,
  versionReady,
  writeMark,
  writePending,
  writeRollback,
  type Pending,
} from './versions.js';

/**
 * THE LAUNCHER — the one part of the program that never updates itself. It is what the computer starts at sign-in
 * (Windows: the starter, Mac: a LaunchAgent, Linux: a systemd user service), on the Node.js that came with the
 * installer. It runs the version `versions/current` names (versions.ts), keeps it running, and undoes a switch that
 * failed. It holds no setting, no store and no network: the program does all of that.
 *
 *   launcher.mjs run    keep the program running — what the system starts
 *   launcher.mjs open   make sure it runs, and open the owner's page once it answers — what the program's icon does
 *
 * The installer's own copy of the program (`<install>/app/`) is put into `versions/` on first start, and again when a
 * newer installer was run over an older program (then as a switch on probation, like an update).
 */
export interface LauncherOptions {
  /** The installed folder: `launcher.mjs`, the runtime, `app/` (the version the installer carried). */
  install: string;
  /** The runtime the installer carried — the one running this launcher. */
  runtime: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  probationMs?: number;
  /** A version that stops sooner than this after its start has «stopped at start». */
  startWindowMs?: number;
  /** How long to wait before trying again when the owner's port was taken (PORT_TAKEN). */
  portRetryMs?: number;
}

export const STOP_GRACE_MS = 90_000;

export async function runLauncher(o: LauncherOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const probationMs = o.probationMs ?? PROBATION_MS;
  const startWindowMs = o.startWindowMs ?? 60_000;
  const portRetryMs = o.portRetryMs ?? 60_000;
  const paths = desktopPaths(dataDir(o.env));
  mkdirSync(paths.versions, { recursive: true, mode: 0o700 });
  const log = launcherLog(paths, now);
  // ONE launcher per data folder, held until this process ends (the store lock's own mechanism, on a file of its own):
  // a second one — the icon clicked again where no system service runs the launcher — leaves at once, before it can
  // start a second copy of the program whose quick ends would read as a version that keeps stopping at start.
  const only = StoreLock.take(join(paths.versions, 'launcher'));
  if (only === undefined) {
    log('another launcher already runs the program — this one leaves');
    return 0;
  }
  log(`launcher started (${o.install})`);

  let stopping = false;
  let child: ChildProcess | undefined;
  const stop = () => {
    stopping = true;
    log('stopping');
    child?.kill('SIGTERM');
    setTimeout(() => child?.kill('SIGKILL'), STOP_GRACE_MS).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  let failedStarts = 0;
  while (!stopping) {
    const version = await ensureCurrent(o, paths, now, log);
    if (stopping) break; // stopped while the installer's copy was being put in place: start nothing
    if (version === undefined) {
      log('no version to run — trying again in a minute');
      await sleep(60_000);
      continue;
    }
    const dir = versionDir(paths.versions, version);
    const onProbation = readPending(paths.versions)?.to === version;
    const startedMs = now();
    log(`starting ${version}${onProbation ? ' (on probation)' : ''}`);
    child = spawn(join(dir, binaryName()), [join(dir, 'app.mjs'), 'desktop', '--no-browser'], {
      env: { ...o.env, KARTA_LAUNCHER: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr!.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') log(`${version}: ${line}`);
    });
    const running = child;
    const ended = new Promise<number | null>((resolve) => {
      running.once('exit', (code) => resolve(code));
      running.once('error', (error) => {
        log(`${version} could not start — ${error.message}`);
        resolve(null);
      });
    });
    const probation = onProbation
      ? setTimeout(() => {
          if (readPending(paths.versions)?.to !== version) return;
          log(`${version} not healthy within ${Math.round(probationMs / 1000)} s — stopping it`);
          running.kill('SIGTERM');
          setTimeout(() => running.kill('SIGKILL'), 10_000).unref();
        }, probationMs)
      : undefined;
    const code = await ended;
    if (probation !== undefined) clearTimeout(probation);
    child = undefined;
    if (stopping) break;

    if (code === RESTART) {
      failedStarts = 0;
      continue;
    }
    if (code === PORT_TAKEN) {
      log(`${version} found the owner's port taken — trying again in ${Math.round(portRetryMs / 1000)} s`);
      await sleep(portRetryMs);
      continue;
    }
    const pending = readPending(paths.versions);
    if (pending?.to === version) {
      rollBack(paths, pending, `η έκδοση ${version} δεν ξεκίνησε σωστά (κωδικός ${code ?? '—'})`, now, log);
      failedStarts = 0;
      continue;
    }
    failedStarts = now() - startedMs < startWindowMs ? failedStarts + 1 : 1;
    log(`${version} stopped (code ${code ?? '—'})`);
    if (failedStarts >= 3 && fallBack(paths, version, now, log)) {
      failedStarts = 0;
      continue;
    }
    await sleep(Math.min(60_000, 1_000 * 2 ** failedStarts));
  }
  log('launcher stopped');
  only.release();
  return 0;
}

/**
 * The version to run: `current`, if it is whole. On the way, the installer's own copy goes into `versions/` when there
 * is none yet, or when it is newer than `current` (a newer installer run over an older program) — that one as a switch
 * on probation. A `pending.json` left by a switch that never happened (it names another version) is dropped.
 */
async function ensureCurrent(o: LauncherOptions, paths: DesktopPaths, now: () => number, log: (line: string) => void): Promise<string | undefined> {
  const versions = paths.versions;
  let current = readMark(versions, 'current');
  const pending = readPending(versions);
  if (pending !== undefined && pending.to !== current) rmSync(join(versions, 'pending.json'), { force: true });

  const bundled = VersionFile.parse(JSON.parse(readFileSync(join(o.install, 'app', 'version.json'), 'utf8')));
  const currentWhole = current !== undefined && versionReady(versions, current);
  const failedBefore = readRollback(versions)?.failed === bundled.version;
  if (!currentWhole || (newer(bundled.version, current!) && !failedBefore)) {
    if (!versionReady(versions, bundled.version)) await placeBundled(o, versions, bundled.version, log);
    if (currentWhole) {
      const into = join(versionDir(versions, bundled.version), '.snapshot');
      snapshotStores(paths, into);
      writePending(versions, { from: current!, to: bundled.version, snapshot: into, atIso: new Date(now()).toISOString() });
      log(`switching ${current} → ${bundled.version} (the installer's)`);
    } else if (current !== undefined) {
      log(`version ${current} is not whole — running the installer's ${bundled.version}`);
    }
    writeMark(versions, 'current', bundled.version);
    current = bundled.version;
  }
  return versionReady(versions, current!) ? current : undefined;
}

/** Copy the installer's runtime and app into `versions/<version>/` — byte by byte (no file attributes come along). */
async function placeBundled(o: LauncherOptions, versions: string, version: string, log: (line: string) => void): Promise<void> {
  const target = versionDir(versions, version);
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    [o.runtime, binaryName()],
    [join(o.install, 'app', 'app.mjs'), 'app.mjs'],
    [join(o.install, 'app', 'version.json'), 'version.json'],
  ] as const) {
    await pipeline(createReadStream(from), createWriteStream(join(partial, to), { mode: 0o600 }));
  }
  chmodSync(join(partial, binaryName()), 0o700);
  renameSync(partial, target);
  log(`placed version ${version} from the installer`);
}

/** Undo a switch whose new version did not pass probation: the stores as they were, the old version again. */
function rollBack(paths: DesktopPaths, pending: Pending, why: string, now: () => number, log: (line: string) => void): void {
  log(`rolling back ${pending.to} → ${pending.from}: ${why}`);
  if (pending.snapshot !== undefined) restoreSnapshot(paths, pending.snapshot);
  writeRollback(paths.versions, { failed: pending.to, back: pending.from, atIso: new Date(now()).toISOString(), why });
  writeMark(paths.versions, 'current', pending.from);
  rmSync(join(paths.versions, 'pending.json'), { force: true });
}

/**
 * `current` stopped three times at start (after its probation): run `previous` instead, once — `previous` is cleared,
 * so the two never take turns. ⓘ No snapshot here: the version had passed probation and may have filed cards.
 */
function fallBack(paths: DesktopPaths, version: string, now: () => number, log: (line: string) => void): boolean {
  const previous = readMark(paths.versions, 'previous');
  if (previous === undefined || previous === version || !versionReady(paths.versions, previous)) {
    log(`${version} keeps stopping at start, and there is no earlier version to go back to`);
    return false;
  }
  log(`${version} stopped three times at start — going back to ${previous}`);
  writeRollback(paths.versions, { failed: version, back: previous, atIso: new Date(now()).toISOString(), why: `η έκδοση ${version} σταματούσε στην εκκίνηση` });
  writeMark(paths.versions, 'current', previous);
  clearMark(paths.versions, 'previous');
  return true;
}

function launcherLog(paths: DesktopPaths, now: () => number): (line: string) => void {
  return (line) => {
    const stamped = `${new Date(now()).toISOString()} launcher: ${line}`;
    console.log(stamped);
    try {
      appendFileSync(paths.log, `${stamped}\n`, { mode: 0o600 });
    } catch {
      /* the console still has it */
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── open: what the program's icon does ────────────────────────────────────────────────────────────────

export const AGENT_LABEL = 'ergani-karta';
export const LINUX_UNIT = 'karta-ergasias.service';

/**
 * Make sure the program runs, then open the owner's page once it answers (a minute at most; then open it anyway, and
 * the browser says it is not there yet). Windows: the starter already runs it. Mac: the LaunchAgent is written (or
 * rewritten when the program moved) and started. Linux: when the page does not answer yet, the systemd user service
 * is started (or, with no systemd, a launcher of its own — a second one leaves at once, runLauncher).
 */
export async function openOwnerPage(o: LauncherOptions): Promise<number> {
  const paths = desktopPaths(dataDir(o.env));
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const log = launcherLog(paths, o.now ?? Date.now);
  const url = `http://127.0.0.1:${ownerPort(o.env)}/`;
  if (process.platform === 'darwin') ensureMacAgent(o, log);
  if (process.platform === 'linux' && !(await answers(url))) {
    const started = spawnSync('systemctl', ['--user', 'start', LINUX_UNIT], { stdio: 'ignore' });
    if (started.status !== 0) {
      // No systemd user session (another kind of Linux): start it here, on its own.
      spawn(o.runtime, [join(o.install, 'launcher.mjs'), 'run'], { detached: true, stdio: 'ignore', env: o.env }).unref();
    }
  }
  for (let i = 0; i < 120 && !(await answers(url)); i += 1) await sleep(500);
  openInBrowser(url, log);
  return 0;
}

function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(url, { timeout: 1_000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * The Mac's LaunchAgent: starts `launcher.mjs run` at sign-in and keeps it running. If the program is moved to the
 * Bin, the agent removes itself at its next start instead of failing for ever.
 */
function ensureMacAgent(o: LauncherOptions, log: (line: string) => void): void {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  const domain = `gui/${userInfo().uid}`;
  const text = macAgentPlist(o.runtime, join(o.install, 'launcher.mjs'), plist);
  const same = existsSync(plist) && readFileSync(plist, 'utf8') === text;
  if (!same) {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    spawnSync('launchctl', ['bootout', `${domain}/${AGENT_LABEL}`], { stdio: 'ignore' });
    writeFileSync(plist, text, { mode: 0o644 });
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
    log(loaded.status === 0 ? 'the LaunchAgent is in place' : 'the LaunchAgent did not load — the program starts at the next sign-in');
  } else {
    spawnSync('launchctl', ['kickstart', `${domain}/${AGENT_LABEL}`], { stdio: 'ignore' });
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function macAgentPlist(runtime: string, launcher: string, plist: string): string {
  const selfRemoving = `if [ -x "$0" ]; then exec "$0" "$1" run; else rm -f "$2"; launchctl bootout gui/$(id -u)/${AGENT_LABEL}; fi`;
  const args = ['/bin/sh', '-c', selfRemoving, runtime, launcher, plist];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>100</integer>
</dict>
</plist>
`;
}
