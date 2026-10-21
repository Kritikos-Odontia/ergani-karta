// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adminCommand } from '../src/stamp/admin.js';
import type { Push } from '../src/stamp/notify.js';
import { AFM } from './fixtures/people.js';

/**
 * THE INSTALLATION — what Docker Compose runs (docker-compose.yml, Dockerfile), read as text: the properties a
 * practice relies on without reading either file. And the licence line on every file of the package.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

/** The lines of one service's block in docker-compose.yml. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(0);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z]+:\n|\nvolumes:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('docker-compose.yml', () => {
  it('⛔ publishes the page on the ONE private address setup checked — never on every address', () => {
    const ports = service('stamp').match(/ports:\n((?:\s+- .*\n)+)/)?.[1] ?? '';
    expect(ports.trim().split('\n')).toEqual(['- "${ERGANI_BIND_ADDRESS:-127.0.0.1}:${ERGANI_PORT:-8880}:8880"']);
    expect(compose).not.toMatch(/0\.0\.0\.0:/);
    // No other service publishes anything.
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1);
  });

  it('runs both services hardened: read-only, no capabilities, no new privileges, always back up', () => {
    const anchor = compose.slice(compose.indexOf('x-hardened:'), compose.indexOf('\nservices:'));
    for (const line of ['read_only: true', '- ALL', '- no-new-privileges:true', 'restart: unless-stopped', '- /tmp']) {
      expect(anchor).toContain(line);
    }
    expect(service('stamp')).toContain('<<: *hardened');
    expect(service('archive')).toContain('<<: *hardened');
  });

  it('keeps each store in its own named volume, and the project\'s name fixed so the volumes keep theirs', () => {
    expect(compose).toMatch(/^name: ergani$/m);
    expect(service('stamp')).toContain('- stamp:/data/stamp');
    expect(service('archive')).toContain('- records:/data/records');
    expect(service('archive')).not.toContain('stamp:/data/stamp');
    expect(service('stamp')).not.toContain('records:/data/records');
  });

  it('runs setup with no network at all — it sends nothing anywhere', () => {
    expect(service('setup')).toContain('network_mode: none');
    expect(service('setup')).toContain('profiles: ["setup"]');
  });

  it('the image runs as the unprivileged node user, with no test tooling', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).not.toMatch(/COPY\s+test/);
  });
});

describe('admin push-test — the owner\'s phone, before go-live', () => {
  it('sends one Greek test push to the configured topic, and refuses when none is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-push-'));
    try {
      const env = {
        STAMP_INSTANCE: 'testclinic',
        STAMP_DB: join(dir, 'stamp.sqlite'),
        STAMP_LABEL: 'Δοκιμή',
        ERGANI_EMPLOYER_AFM: AFM.employer,
        ERGANI_BRANCH_0_USERNAME: 'fixture01',
        ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
        ERGANI_USERTYPE: '02',
        ERGANI_BASE_URL: 'http://127.0.0.1:9/WebservicesAPI/api',
      };
      const sent: Push[] = [];
      const io = { now: () => 0, out: () => undefined, send: async (p: Push) => void sent.push(p) };
      await adminCommand(['init'], env, io);
      expect(await adminCommand(['push-test'], env, io)).toBe(0);
      expect(sent).toEqual([{ title: 'ΕΡΓΑΝΗ — Δοκιμή', message: expect.stringMatching(/^Δοκιμή ειδοποίησης/), priority: 4 }]);
      await expect(adminCommand(['push-test'], env, { now: () => 0, out: () => undefined })).rejects.toThrow(/no phone push/);
      // The store is written for its owner only.
      expect(statSync(join(dir, 'stamp.sqlite')).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the licence — EUPL-1.2 on every file of the package', () => {
  const license = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license as string;
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    );

  it('package.json says EUPL-1.2, and LICENSE is its text', () => {
    expect(license).toBe('EUPL-1.2');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toMatch(/EUROPEAN UNION PUBLIC LICEN[CS]E v\. ?1\.2/i);
  });

  it('the Windows installer script is UTF-8 WITH its byte-order mark — so Inno Setup reads its Greek as Greek', () => {
    const iss = readFileSync(join(root, 'packaging', 'windows', 'karta.iss'));
    expect([...iss.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(iss.toString('utf8')).toContain('AppName=Κάρτα Εργασίας');
  });

  it('the Windows firewall rules name the program every version runs on — open on private networks, closed on public ones', () => {
    const iss = readFileSync(join(root, 'packaging', 'windows', 'karta.iss'), 'utf8');
    const adds = iss.split('\n').filter((line) => line.includes('firewall add rule'));
    expect(adds).toHaveLength(2);
    expect(adds[0]).toContain('action=allow program=""{app}\\node.exe"" protocol=TCP localport=8880 profile=private remoteip=localsubnet');
    expect(adds[1]).toContain('action=block program=""{app}\\node.exe"" profile=public');
    // Rules Windows made by itself for older per-version copies go, at install and at uninstall.
    expect(iss.match(/Karta Ergasias\\versions\\\*' \} \| Get-NetFirewallRule \| Remove-NetFirewallRule/g)).toHaveLength(2);
  });

  it('every source, test, migration, build and install file carries the SPDX line', () => {
    // JSON and property lists cannot carry a comment; the pictures are not code.
    const carriesNoComment = (f: string) => /(\.(json|plist|png|icns|ico|svg)|[\\/]control)$/.test(f);
    const ours = [
      ...files('src').filter((f) => !f.startsWith(join('src', 'brand'))),
      ...files('test').filter((f) => !f.startsWith(join('test', 'fixtures', 'ministry'))),
      ...files('scripts'),
      ...files('packaging').filter((f) => !carriesNoComment(f)),
      ...files(join('.github', 'workflows')),
      'Dockerfile', 'docker-compose.yml', 'vitest.config.ts',
    ];
    const missing = ours.filter((f) => !readFileSync(join(root, f), 'utf8').slice(0, 200).includes(`SPDX-License-Identifier: ${license}`));
    expect(missing).toEqual([]);
  });
});
