// SPDX-License-Identifier: EUPL-1.2
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopPaths, type DesktopPaths } from '../src/desktop/paths.js';
import { readDesktopState, writeDesktopState } from '../src/desktop/state.js';
import { SYSTEMS, UPDATE_KEYS, newer, parseSums, sha256, signedByUs, thisSystem, verifiedRelease } from '../src/update/release.js';
import { Updater, nightWindow } from '../src/update/updater.js';
import { RESTART, binaryName, writeRollback } from '../src/update/versions.js';
import { REPOSITORY, VERSION } from '../src/version.js';

/**
 * THE UPDATER — against a stand-in for GitHub's releases API on 127.0.0.1, with releases signed by a key made for the
 * test (the program's own key is not used, and its private half is nowhere near the tests). What is held: only a
 * release signed by a key the program holds is seen or installed; every file must match the signed list; the request
 * carries nothing but the question; the switch stops the stamping before the snapshot and ends the program with
 * RESTART; nothing is switched when anything is wrong; the night rule.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

const testKey = generateKeyPairSync('ed25519');
const TEST_KEYS = [testKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')];

interface Release {
  files: Map<string, Buffer>;
}

/** A release of `version`, signed by `key`, carrying `app` and a runtime per system. */
function release(version: string, options: { key?: typeof testKey.privateKey; node?: string; tamper?: string; app?: string } = {}): Release {
  const node = options.node ?? '99.0.0';
  const files = new Map<string, Buffer>();
  files.set(`karta-app-${version}.mjs`, Buffer.from(options.app ?? `// the app ${version}\n`));
  const runtimes: Record<string, string> = {};
  for (const system of SYSTEMS) {
    const name = `karta-node-v${node}-${system}.gz`;
    runtimes[system] = name;
    files.set(name, gzipSync(Buffer.from(`runtime ${system} ${node}`)));
  }
  files.set('manifest.json', Buffer.from(JSON.stringify({ format: 1, version, app: `karta-app-${version}.mjs`, node, runtimes })));
  const sums = Buffer.from([...files].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''));
  files.set('SHA256SUMS', sums);
  files.set('SHA256SUMS.sig', Buffer.from(sign(null, sums, options.key ?? testKey.privateKey).toString('base64')));
  if (options.tamper !== undefined) files.set(options.tamper, Buffer.concat([files.get(options.tamper)!, Buffer.from('x')]));
  return { files };
}

interface Fake {
  api: string;
  seen: Array<{ url: string; headers: IncomingHttpHeaders }>;
  serve: (r: Release | undefined) => void;
  assetBase: (base: string) => void;
}

async function fakeGithub(): Promise<Fake> {
  let current: Release | undefined;
  let assetBase: string | undefined;
  const seen: Fake['seen'] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === `/repos/${REPOSITORY}/releases/latest`) {
      if (current === undefined) return void res.writeHead(404).end('{}');
      const names = [...current.files.keys()];
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({
        tag_name: 'v',
        assets: names.map((name, i) => ({ name, url: `${assetBase ?? api}/repos/${REPOSITORY}/releases/assets/${i}`, size: current!.files.get(name)!.length })),
      }));
    }
    const match = /\/releases\/assets\/(\d+)$/.exec(req.url ?? '');
    const bytes = match === null || current === undefined ? undefined : [...current.files.values()][Number(match[1])];
    if (bytes === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    api: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    serve: (r) => void (current = r),
    assetBase: (b) => void (assetBase = b),
  };
}

function setUp(): DesktopPaths {
  const root = mkdtempSync(join(tmpdir(), 'karta-updater-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = desktopPaths(root);
  mkdirSync(paths.versions, { recursive: true });
  writeDesktopState(paths.desktop, { ownerPassword: 'scrypt$test', nightUpdates: true });
  return paths;
}

function updater(paths: DesktopPaths, fake: Fake, more: { quiet?: (t: number, since: number) => boolean; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  const happened: string[] = [];
  const u = new Updater({
    paths,
    env: more.env ?? {},
    now: more.now ?? Date.now,
    log: () => {},
    quiet: more.quiet ?? (() => true),
    stopServices: async () => {
      happened.push(`stopped (snapshot there: ${existsSync(join(paths.versions, '0.2.0', '.snapshot'))})`);
    },
    exit: (code) => happened.push(`exit ${code}`),
    api: fake.api,
    keys: TEST_KEYS,
    version: '0.1.0',
  });
  return { u, happened };
}

describe('a release: the signature first, then the signed list', () => {
  it('only a key the program holds verifies; one byte changed, or another key, does not', () => {
    const r = release('0.2.0');
    const files = { sums: r.files.get('SHA256SUMS')!, signature: r.files.get('SHA256SUMS.sig')!.toString(), manifest: r.files.get('manifest.json')! };
    expect(verifiedRelease(files, TEST_KEYS).manifest.version).toBe('0.2.0');
    expect(() => verifiedRelease(files, UPDATE_KEYS)).toThrow(/υπογραφή/);
    const changed = Buffer.from(files.sums);
    changed[0] = changed[0] === 0x30 ? 0x31 : 0x30;
    expect(signedByUs(changed, files.signature, TEST_KEYS)).toBe(false);
    expect(signedByUs(files.sums, 'AAAA', TEST_KEYS)).toBe(false);
  });

  it('a manifest that is not the signed one, or names a file outside the list, or a path, is refused', () => {
    const r = release('0.2.0', { tamper: 'manifest.json' });
    expect(() => verifiedRelease({ sums: r.files.get('SHA256SUMS')!, signature: r.files.get('SHA256SUMS.sig')!.toString(), manifest: r.files.get('manifest.json')! }, TEST_KEYS)).toThrow(/manifest/);
    const pathLike = Buffer.from(JSON.stringify({ format: 1, version: '0.2.0', app: '../app.mjs', node: '1.0.0', runtimes: {} }));
    const sums = Buffer.from(`${sha256(pathLike)}  manifest.json\n`);
    const signature = sign(null, sums, testKey.privateKey).toString('base64');
    expect(() => verifiedRelease({ sums, signature, manifest: pathLike }, TEST_KEYS)).toThrow();
    const missing = Buffer.from(JSON.stringify({ format: 1, version: '0.2.0', app: 'app.mjs', node: '1.0.0', runtimes: {} }));
    const sums2 = Buffer.from(`${sha256(missing)}  manifest.json\n`);
    expect(() => verifiedRelease({ sums: sums2, signature: sign(null, sums2, testKey.privateKey).toString('base64'), manifest: missing }, TEST_KEYS)).toThrow(/λείπει/);
  });

  it('the signed list is read strictly; versions compare by number', () => {
    expect(() => parseSums(`${'a'.repeat(64)} x\n`)).toThrow();
    expect(() => parseSums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n`)).toThrow();
    expect(() => parseSums(`${'a'.repeat(64)}  ../x\n`)).toThrow();
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
    expect(newer('0.1.9', '0.2.0')).toBe(false);
  });

  it('the program asks the repository package.json names — one place to rename', () => {
    expect(REPOSITORY.split('/')[1]).toBe(pkg.name);
    expect(VERSION).toBe(pkg.version);
    expect(thisSystem('win32', 'x64')).toBe('win32-x64');
    expect(thisSystem('linux', 'arm64')).toBeUndefined();
  });
});

describe('the daily check', () => {
  it('a newer signed release is noted as available; the question carries nothing else', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0'));
    const found = await updater(paths, fake).u.check();
    expect(found).toMatchObject({ ok: true, available: '0.2.0' });
    expect(readDesktopState(paths.desktop)?.update?.available).toBe('0.2.0');
    const ask = fake.seen[0]!;
    expect(ask.url).toBe(`/repos/${REPOSITORY}/releases/latest`);
    expect(ask.headers['user-agent']).toBe('karta-ergasias');
    expect(ask.headers['authorization']).toBeUndefined();
    expect(Object.keys(ask.headers).filter((h) => !['host', 'connection', 'accept', 'user-agent', 'x-github-api-version', 'accept-encoding', 'accept-language', 'sec-fetch-mode'].includes(h))).toEqual([]);
  });

  it('a release signed by another key is not «available»: the check says why', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0', { key: generateKeyPairSync('ed25519').privateKey }));
    const found = await updater(paths, fake).u.check();
    expect(found.ok).toBe(false);
    expect(found.available).toBeUndefined();
    expect(found.problem).toMatch(/υπογραφή/);
  });

  it('no release, or an older one: up to date; a login only when one is given', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    expect(await updater(paths, fake).u.check()).toMatchObject({ ok: true });
    fake.serve(release('0.0.9'));
    const found = await updater(paths, fake, { env: { KARTA_UPDATE_TOKEN: 'test-token' } }).u.check();
    expect(found).toMatchObject({ ok: true });
    expect(found.available).toBeUndefined();
    expect(fake.seen.at(-1)!.headers['authorization']).toBe('Bearer test-token');
  });
});

describe('installing', () => {
  it('downloads, checks every file, stops the stamping, takes the snapshot, switches, and ends with RESTART', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0'));
    const { u, happened } = updater(paths, fake);
    expect(await u.install()).toBeUndefined();
    expect(happened).toEqual(['stopped (snapshot there: false)', `exit ${RESTART}`]);
    const dir = join(paths.versions, '0.2.0');
    expect(readFileSync(join(dir, 'app.mjs'), 'utf8')).toBe('// the app 0.2.0\n');
    expect(readFileSync(join(dir, binaryName()), 'utf8')).toBe(`runtime ${thisSystem()} 99.0.0`); // unpacked
    expect(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'))).toEqual({ version: '0.2.0', node: '99.0.0' });
    expect(existsSync(join(dir, '.snapshot', 'complete'))).toBe(true);
    expect(readFileSync(join(paths.versions, 'current'), 'utf8').trim()).toBe('0.2.0');
    expect(JSON.parse(readFileSync(join(paths.versions, 'pending.json'), 'utf8'))).toMatchObject({ from: '0.1.0', to: '0.2.0' });
  });

  it('the same Node.js is copied, not downloaded', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    const r = release('0.2.0', { node: process.versions.node });
    fake.serve(r);
    await updater(paths, fake).u.install();
    const runtime = [...r.files.keys()].indexOf(`karta-node-v${process.versions.node}-${thisSystem()}.gz`);
    expect(fake.seen.map((s) => s.url)).not.toContain(`/repos/${REPOSITORY}/releases/assets/${runtime}`);
    expect(readFileSync(join(paths.versions, '0.2.0', binaryName())).length).toBe(readFileSync(process.execPath).length);
  });

  it('a file that does not match the signed list: nothing switched, nothing stopped, the reason noted', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0', { tamper: 'karta-app-0.2.0.mjs' }));
    const { u, happened } = updater(paths, fake);
    await u.check();
    const result = await u.install();
    expect(result?.problem).toMatch(/δεν ταιριάζει/);
    expect(happened).toEqual([]);
    expect(existsSync(join(paths.versions, '0.2.0'))).toBe(false);
    expect(existsSync(join(paths.versions, '0.2.0.partial'))).toBe(false);
    expect(existsSync(join(paths.versions, 'current'))).toBe(false);
    expect(readDesktopState(paths.desktop)?.update?.installProblem?.problem).toMatch(/δεν ταιριάζει/);
  });

  it('a release file at any other address than this repository’s on the API is refused', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0'));
    fake.assetBase('http://127.0.0.1:1');
    const { u, happened } = updater(paths, fake);
    expect((await u.install())?.problem).toMatch(/άλλη διεύθυνση/);
    expect(happened).toEqual([]);
  });

  it('a card on its way to ΕΡΓΑΝΗ: not now', async () => {
    const fake = await fakeGithub();
    const paths = setUp();
    fake.serve(release('0.2.0'));
    const { u, happened } = updater(paths, fake, { quiet: () => false });
    expect((await u.install())?.problem).toMatch(/καθ’ οδόν/);
    expect(happened).toEqual([]);
  });
});

describe('at night, by itself', () => {
  // 03:00 and 12:00 Athens time on a winter day (UTC+2).
  const night = Date.parse('2026-12-01T01:00:00Z');
  const day = Date.parse('2026-12-01T10:00:00Z');

  it('02:00–05:00 Athens only', () => {
    expect(nightWindow(night)).toBe(true);
    expect(nightWindow(day)).toBe(false);
    expect(nightWindow(Date.parse('2026-12-01T03:00:00Z'))).toBe(false); // 05:00
    expect(nightWindow(Date.parse('2026-07-01T23:30:00Z'))).toBe(true); // 02:30 in summer (UTC+3)
  });

  it('installs at night with the switch on and nobody stamping; not in the day, not switched off, not after a stamp, not a version that rolled back', async () => {
    const fake = await fakeGithub();
    fake.serve(release('0.2.0'));
    const cases: Array<[string, number, boolean, boolean, boolean, boolean]> = [
      // what, when, switch on, quiet, rolled back before, installs
      ['night', night, true, true, false, true],
      ['day', day, true, true, false, false],
      ['switched off', night, false, true, false, false],
      ['a stamp in the last hour', night, true, false, false, false],
      ['rolled back before', night, true, true, true, false],
    ];
    for (const [what, at, on, quiet, rolledBack, installs] of cases) {
      const paths = setUp();
      writeDesktopState(paths.desktop, { ownerPassword: 'scrypt$test', nightUpdates: on });
      if (rolledBack) writeRollback(paths.versions, { failed: '0.2.0', back: '0.1.0', atIso: new Date(at).toISOString(), why: 'test' });
      const { u, happened } = updater(paths, fake, { now: () => at, quiet: (_t, since) => quiet || since === 0 });
      await u.tick();
      expect([what, happened.includes(`exit ${RESTART}`)]).toEqual([what, installs]);
    }
  });
});
