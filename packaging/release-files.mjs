// SPDX-License-Identifier: EUPL-1.2
// THE RELEASE'S SIGNED LIST — the last step of .github/workflows/release.yml, over the folder of everything a release
// carries. It writes:
//   manifest.json    the version, the app's file, Node.js's version, and each system's runtime file
//   SHA256SUMS       `<sha256>  <file>` for every file, manifest.json included
//   SHA256SUMS.sig   an Ed25519 signature over the exact bytes of SHA256SUMS (base64), with the update-signing key:
//                    PKCS8 DER, base64, in the environment as UPDATE_SIGNING_KEY — the repository's one secret, given
//                    to this step only, never printed
// ⛔ It refuses to sign with a key whose public half the program does not hold (src/update/release.ts, UPDATE_KEYS):
// a release no installed copy would accept is stopped here, not found out on a practice's computer.
//   node packaging/release-files.mjs <folder> <version> <node version> <file listing the accepted public keys>
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [folder, version, node, keysFile] = process.argv.slice(2);
if (keysFile === undefined) {
  console.error('usage: release-files.mjs <folder> <version> <node version> <file listing the accepted public keys>');
  process.exit(2);
}
const SYSTEMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
const app = `karta-app-${version}.mjs`;
const runtimes = Object.fromEntries(SYSTEMS.map((system) => [system, `karta-node-v${node}-${system}.gz`]));
for (const name of [app, ...Object.values(runtimes)]) {
  if (!existsSync(join(folder, name))) {
    console.error(`missing from the release: ${name}`);
    process.exit(1);
  }
}
writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify({ format: 1, version, app, node, runtimes }, null, 2)}\n`);

const names = readdirSync(folder)
  .filter((name) => name !== 'SHA256SUMS' && name !== 'SHA256SUMS.sig')
  .sort();
const sums = names.map((name) => `${createHash('sha256').update(readFileSync(join(folder, name))).digest('hex')}  ${name}\n`).join('');
writeFileSync(join(folder, 'SHA256SUMS'), sums);

const secret = process.env.UPDATE_SIGNING_KEY ?? '';
if (secret === '') {
  console.error('UPDATE_SIGNING_KEY is not set: a release is not published unsigned.');
  process.exit(1);
}
const key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
const ours = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
if (!readFileSync(keysFile, 'utf8').includes(`'${ours}'`)) {
  console.error('the signing key is not one the program accepts (src/update/release.ts, UPDATE_KEYS) — refused.');
  process.exit(1);
}
writeFileSync(join(folder, 'SHA256SUMS.sig'), `${sign(null, Buffer.from(sums), key).toString('base64')}\n`);
console.log(`signed ${names.length} files of ${version}`);
