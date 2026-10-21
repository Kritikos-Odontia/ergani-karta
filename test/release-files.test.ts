// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEMS, verifiedRelease } from '../src/update/release.js';

/**
 * THE RELEASE WORKFLOW'S LAST STEP (packaging/release-files.mjs), against the program's own check (release.ts): what
 * CI signs is exactly what an installed copy verifies; a key the program does not hold is refused before signing; a
 * release is never published unsigned. The key here is made for the test.
 */
const SCRIPT = new URL('../packaging/release-files.mjs', import.meta.url).pathname;
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karta-release-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'karta-app-0.3.0.mjs'), '// app');
  for (const system of SYSTEMS) writeFileSync(join(dir, `karta-node-v24.22.1-${system}.gz`), system);
  writeFileSync(join(dir, 'karta-ergasias-0.3.0-windows-x64-setup.exe'), 'installer');
  return dir;
}

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    secret: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    public: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function run(dir: string, secret: string, accepted: string) {
  const list = join(dir, '..', `${dir.split('/').pop()}-keys.ts`);
  writeFileSync(list, `export const UPDATE_KEYS = ['${accepted}'];\n`);
  cleanup.push(() => rmSync(list, { force: true }));
  return spawnSync(process.execPath, [SCRIPT, dir, '0.3.0', '24.22.1', list], { env: { PATH: process.env['PATH'], UPDATE_SIGNING_KEY: secret }, encoding: 'utf8' });
}

describe('the release’s signed list', () => {
  it('what CI signs, the program verifies — manifest, every file, the signature', () => {
    const dir = folder();
    const key = keys();
    const result = run(dir, key.secret, key.public);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(key.secret);
    const verified = verifiedRelease(
      { sums: readFileSync(join(dir, 'SHA256SUMS')), signature: readFileSync(join(dir, 'SHA256SUMS.sig'), 'utf8'), manifest: readFileSync(join(dir, 'manifest.json')) },
      [key.public],
    );
    expect(verified.manifest).toMatchObject({ version: '0.3.0', app: 'karta-app-0.3.0.mjs', node: '24.22.1' });
    expect(verified.sums.has('karta-ergasias-0.3.0-windows-x64-setup.exe')).toBe(true);
  });

  it('refuses a key the program does not hold, and refuses to publish unsigned', () => {
    const dir = folder();
    const signing = keys();
    expect(run(dir, signing.secret, keys().public).status).not.toBe(0);
    expect(run(dir, '', signing.public).status).not.toBe(0);
  });

  it('the program’s own key list is where CI looks', () => {
    expect(readFileSync(new URL('../src/update/release.ts', import.meta.url), 'utf8')).toMatch(/UPDATE_KEYS[^=]*=\s*\[\s*(\/\/[^\n]*\n\s*)*'MC[A-Za-z0-9+/=]+'/);
  });
});
