// SPDX-License-Identifier: EUPL-1.2
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import type { DesktopPaths } from '../desktop/paths.js';
import { readDesktopState, writeDesktopState, type UpdateRecord } from '../desktop/state.js';
import { athensTime } from '../stamp/athens.js';
import { REPOSITORY, VERSION } from '../version.js';
import { UPDATE_KEYS, newer, thisSystem, verifiedRelease, type VerifiedRelease } from './release.js';
import { RESTART, binaryName, readRollback, snapshotStores, versionDir, writeMark, writePending } from './versions.js';

/**
 * THE UPDATER — inside the program, when the launcher runs it (launcher.ts). His ruling: updates through the
 * project's GitHub releases, AUTOMATIC AT NIGHT, ON from the start, the practice may switch it off; only a release
 * signed with our key installs (release.ts); it can go back by itself (versions.ts).
 *
 *   · Once a day, ONE question to GitHub's public releases API: «the newest release of this repository». Nothing is
 *     sent with it — no installation id, no version, no count, no data. With a newer, signed release, the owner's
 *     pages say «νέα έκδοση x.y.z» and offer «Ενημέρωση τώρα».
 *   · At night (02:00–05:00 Athens), with the switch on: it installs by itself — only when no card is on its way to
 *     ΕΡΓΑΝΗ and nobody has stamped in the last hour; never in the day. A version that once rolled back is not tried
 *     again by itself (the button still can).
 *   · Installing: download into `versions/<new>.partial/` and check every file against the signed list; the same
 *     Node.js is copied instead of downloaded; then THE SWITCH (versions.ts): the stamping stops, the stores are
 *     copied, `current` names the new version, and the program ends with `RESTART` — the launcher starts the new one.
 * ⓘ The download is the program's own, not a browser's: nothing marks the files as «from the internet», so the
 * system's warnings for an unsigned program are never shown again after the first install.
 */
export const API = 'https://api.github.com';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_ASSET_BYTES = 300 * 1024 * 1024;
/** The release list, the signed list, its signature, the manifest: small, or not ours. */
const SMALL_BYTES = 1024 * 1024;
/** A runtime, unpacked: Node.js is about 120 MB; anything far larger is not one. */
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

const Release = z.object({
  assets: z.array(z.object({ name: z.string(), url: z.string(), size: z.number() })),
});

export interface UpdaterOptions {
  paths: DesktopPaths;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  /** No card on its way to ΕΡΓΑΝΗ, and (for the night) no stamp within `sinceMs`. */
  quiet: (nowMs: number, sinceMs: number) => boolean;
  /** Stop the stamping and the owner's pages, the card on its way finishing first (desktop/main.ts). */
  stopServices: () => Promise<void>;
  exit: (code: number) => void;
  // For the tests: another API address, other keys, another version.
  api?: string;
  keys?: readonly string[];
  version?: string;
  fetch?: typeof fetch;
}

export class Updater {
  readonly #o: UpdaterOptions;
  readonly #api: string;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  #busy = false;
  #lastInstallTryMs = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: UpdaterOptions) {
    this.#o = o;
    this.#api = o.api ?? API;
    this.#version = o.version ?? VERSION;
    this.#fetch = o.fetch ?? fetch;
  }

  get version(): string {
    return this.#version;
  }

  get busy(): boolean {
    return this.#busy;
  }

  record(): UpdateRecord | undefined {
    return readDesktopState(this.#o.paths.desktop)?.update;
  }

  /**
   * The newer version the last check found — never the one running now: the note of a check made before a switch
   * stays until the next check, and it names the version this program already is.
   */
  available(): string | undefined {
    const found = this.record()?.available;
    return found !== undefined && newer(found, this.#version) ? found : undefined;
  }

  /** Every ten minutes: the daily check when due, and at night the install. */
  start(): void {
    this.#timer = setInterval(() => void this.tick().catch((e: unknown) => this.#o.log(`update: ${message(e)}`)), 10 * 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async tick(): Promise<void> {
    const now = this.#o.now();
    const record = this.record();
    const since = record === undefined ? Infinity : now - Date.parse(record.checkedIso);
    if (since >= DAY_MS || (record?.ok === false && since >= HOUR_MS)) await this.check();
    const available = this.available();
    if (readDesktopState(this.#o.paths.desktop)?.nightUpdates !== true || available === undefined || !nightWindow(now)) return;
    if (readRollback(this.#o.paths.versions)?.failed === available) return;
    if (now - this.#lastInstallTryMs < HOUR_MS || !this.#o.quiet(now, HOUR_MS)) return;
    this.#lastInstallTryMs = now;
    this.#o.log(`update: installing ${available} (night)`);
    await this.install('night');
  }

  /**
   * Whether the program may stop for the switch NOW — asked before the download and again right before the stamping
   * stops (a download can take minutes): at night only inside the window, with the switch on and nobody stamping in
   * the last hour; by the owner's button, whenever no card is on its way.
   */
  #mayStop(by: 'night' | 'button'): string | undefined {
    const now = this.#o.now();
    if (by === 'night') {
      if (!nightWindow(now) || readDesktopState(this.#o.paths.desktop)?.nightUpdates !== true) return 'η νύχτα πέρασε ή οι νυχτερινές ενημερώσεις κλείστηκαν — την επόμενη νύχτα';
      if (!this.#o.quiet(now, HOUR_MS)) return 'κάποιος χτύπησε την τελευταία ώρα — την επόμενη νύχτα';
      return undefined;
    }
    return this.#o.quiet(now, 0) ? undefined : 'μια κάρτα είναι καθ’ οδόν προς την ΕΡΓΑΝΗ — δοκιμάστε σε λίγα λεπτά';
  }

  /** Ask GitHub for the newest release; note what was found (desktop.json). */
  async check(): Promise<UpdateRecord> {
    const checkedIso = new Date(this.#o.now()).toISOString();
    let found: UpdateRecord;
    try {
      const release = await this.#newest();
      const available = release !== undefined && newer(release.verified.manifest.version, this.#version) ? release.verified.manifest.version : undefined;
      found = { checkedIso, ok: true, ...(available === undefined ? {} : { available }) };
      this.#o.log(`update check: ${available === undefined ? 'up to date' : `${available} available`}`);
    } catch (error) {
      found = { checkedIso, ok: false, problem: message(error) };
      this.#o.log(`update check failed — ${message(error)}`);
    }
    const state = readDesktopState(this.#o.paths.desktop);
    if (state !== undefined) {
      const installProblem = state.update?.installProblem;
      writeDesktopState(this.#o.paths.desktop, { ...state, update: { ...found, ...(installProblem === undefined ? {} : { installProblem }) } });
    }
    return found;
  }

  /**
   * Download, check and switch to the newest release. Returns only when it did NOT switch — every such outcome is
   * noted (the «Ενημερώσεις» page says why) and returned; after the switch the program ends.
   */
  async install(by: 'night' | 'button' = 'button'): Promise<{ problem: string } | undefined> {
    if (this.#busy) return { problem: 'μια ενημέρωση είναι ήδη σε εξέλιξη' };
    this.#busy = true;
    try {
      const problem = await this.#tryInstall(by);
      if (problem === undefined) return undefined;
      const state = readDesktopState(this.#o.paths.desktop);
      if (state?.update !== undefined) {
        writeDesktopState(this.#o.paths.desktop, { ...state, update: { ...state.update, installProblem: { atIso: new Date(this.#o.now()).toISOString(), problem } } });
      }
      return { problem };
    } finally {
      this.#busy = false;
    }
  }

  /** The install itself: `undefined` once switched, otherwise why not. */
  async #tryInstall(by: 'night' | 'button'): Promise<string | undefined> {
    try {
      const release = await this.#newest();
      if (release === undefined || !newer(release.verified.manifest.version, this.#version)) return 'δεν υπάρχει νεότερη έκδοση';
      const notNow = this.#mayStop(by);
      if (notNow !== undefined) return notNow;
      const to = await this.#download(release);
      const notAnyMore = this.#mayStop(by);
      if (notAnyMore !== undefined) {
        this.#o.log(`update: ${to} downloaded, not switched — ${notAnyMore}`);
        return notAnyMore;
      }
      await this.#switch(to);
      return undefined;
    } catch (error) {
      const problem = message(error);
      this.#o.log(`update failed — ${problem}`);
      return problem;
    }
  }

  async #newest(): Promise<{ verified: VerifiedRelease; assets: Map<string, { url: string; size: number }> } | undefined> {
    const answer = await this.#get(`${this.#api}/repos/${REPOSITORY}/releases/latest`, 'application/vnd.github+json');
    if (answer.status === 404) return undefined; // no release yet
    if (!answer.ok) throw new Error(`το GitHub απάντησε ${answer.status}`);
    const release = Release.parse(JSON.parse(Buffer.from(await capped(answer, SMALL_BYTES)).toString('utf8')));
    const assets = new Map(release.assets.map((a) => [a.name, { url: a.url, size: a.size }]));
    // The workflow adds the signed list last: a release without it is still being built (or its build failed) — for
    // an installed copy, nothing new yet, not a failed check.
    if (!assets.has('SHA256SUMS') || !assets.has('SHA256SUMS.sig')) return undefined;
    const small = async (name: string) => {
      const asset = assets.get(name);
      if (asset === undefined) throw new Error(`η έκδοση δεν έχει ${name}`);
      return this.#asset(asset, SMALL_BYTES);
    };
    const verified = verifiedRelease(
      { sums: await small('SHA256SUMS'), signature: Buffer.from(await small('SHA256SUMS.sig')).toString('utf8'), manifest: await small('manifest.json') },
      this.#o.keys ?? UPDATE_KEYS,
    );
    return { verified, assets };
  }

  /** The new version, whole, in `versions/<x.y.z>/` — every file checked against the signed list. */
  async #download(release: { verified: VerifiedRelease; assets: Map<string, { url: string; size: number }> }): Promise<string> {
    const { manifest, sums } = release.verified;
    const system = thisSystem();
    const runtimeName = system === undefined ? undefined : manifest.runtimes[system];
    if (runtimeName === undefined) throw new Error('η έκδοση δεν έχει πρόγραμμα για αυτόν τον υπολογιστή');
    const target = versionDir(this.#o.paths.versions, manifest.version);
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    try {
      await this.#fill(release, partial, runtimeName);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
    renameSync(partial, target);
    this.#o.log(`update: ${manifest.version} downloaded and checked`);
    return manifest.version;
  }

  async #fill(release: { verified: VerifiedRelease; assets: Map<string, { url: string; size: number }> }, partial: string, runtimeName: string): Promise<void> {
    const { manifest, sums } = release.verified;
    const fetchChecked = async (name: string, to: string, gunzip: boolean) => {
      const asset = release.assets.get(name);
      if (asset === undefined) throw new Error(`η έκδοση δεν έχει ${name}`);
      const digest = await this.#assetToFile(asset, to, gunzip);
      if (digest !== sums.get(name)) throw new Error(`το ${name} δεν ταιριάζει με τον υπογεγραμμένο κατάλογο`);
    };
    await fetchChecked(manifest.app, join(partial, 'app.mjs'), false);
    if (manifest.node === process.versions.node) {
      // The same Node.js: copied from the one running now, not downloaded again.
      await pipeline(createReadStream(process.execPath), createWriteStream(join(partial, binaryName()), { mode: 0o600 }));
    } else {
      await fetchChecked(runtimeName, join(partial, binaryName()), true);
    }
    chmodSync(join(partial, binaryName()), 0o700);
    writeFileSync(join(partial, 'version.json'), `${JSON.stringify({ version: manifest.version, node: manifest.node })}\n`, { mode: 0o600 });
  }

  /** The switch (versions.ts). Any failure once the stamping has stopped: back to this version, by a restart. */
  async #switch(to: string): Promise<void> {
    const versions = this.#o.paths.versions;
    this.#o.log(`update: switching ${this.#version} → ${to}`);
    try {
      // Inside: a stop that fails half-way still ends in the restart, so the staff page never stays dark.
      await this.#o.stopServices();
      const snapshot = join(versionDir(versions, to), '.snapshot');
      snapshotStores(this.#o.paths, snapshot);
      writePending(versions, { from: this.#version, to, snapshot, atIso: new Date(this.#o.now()).toISOString() });
      writeMark(versions, 'current', to);
    } catch (error) {
      this.#o.log(`update: the switch failed before it happened — ${message(error)}; starting ${this.#version} again`);
      rmSync(join(versions, 'pending.json'), { force: true });
      writeMark(versions, 'current', this.#version);
    }
    this.#o.exit(RESTART);
  }

  #get(url: string, accept: string): Promise<Response> {
    const token = this.#o.env['KARTA_UPDATE_TOKEN'];
    return this.#fetch(url, {
      headers: {
        accept,
        'user-agent': 'karta-ergasias',
        'x-github-api-version': '2022-11-28',
        ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15 * 60_000),
    });
  }

  /** ⛔ Only this repository's own release files, by GitHub's API address for them. */
  #assetUrl(asset: { url: string; size: number }, max: number): string {
    if (!asset.url.startsWith(`${this.#api}/repos/${REPOSITORY}/releases/assets/`)) throw new Error('αρχείο έκδοσης από άλλη διεύθυνση');
    if (asset.size > max) throw new Error('αρχείο έκδοσης πολύ μεγάλο');
    return asset.url;
  }

  async #asset(asset: { url: string; size: number }, max: number): Promise<Uint8Array> {
    const answer = await this.#get(this.#assetUrl(asset, max), 'application/octet-stream');
    if (!answer.ok) throw new Error(`το GitHub απάντησε ${answer.status}`);
    return capped(answer, max);
  }

  /** Stream a release file to disk (gunzipped if asked), returning the sha256 of the bytes as downloaded. */
  async #assetToFile(asset: { url: string; size: number }, to: string, gunzip: boolean): Promise<string> {
    const answer = await this.#get(this.#assetUrl(asset, MAX_ASSET_BYTES), 'application/octet-stream');
    if (!answer.ok || answer.body === null) throw new Error(`το GitHub απάντησε ${answer.status}`);
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > MAX_ASSET_BYTES) return done(new Error('αρχείο έκδοσης πολύ μεγάλο'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    let unpacked = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        unpacked += chunk.length;
        done(unpacked > MAX_UNPACKED_BYTES ? new Error('αρχείο έκδοσης πολύ μεγάλο') : null, chunk);
      },
    });
    const body = Readable.fromWeb(answer.body as import('node:stream/web').ReadableStream);
    const out = createWriteStream(to, { mode: 0o600 });
    await (gunzip ? pipeline(body, tap, createGunzip(), cap, out) : pipeline(body, tap, out));
    return hash.digest('hex');
  }
}

/**
 * An answer's body, read chunk by chunk and abandoned the moment it passes `max` — whatever the answer claims its size
 * is. (Everything is read before its signature is checked, so nothing unbounded is ever held.)
 */
export async function capped(answer: Response, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (answer.body === null) return new Uint8Array();
  const reader = answer.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('απάντηση πολύ μεγάλη');
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** 02:00–05:00, Athens time — when a practice is closed. */
export function nightWindow(nowMs: number): boolean {
  const hour = Number(athensTime(nowMs).time.slice(0, 2));
  return hour >= 2 && hour < 5;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
