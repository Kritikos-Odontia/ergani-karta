// SPDX-License-Identifier: EUPL-1.2
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build, type Plugin } from 'esbuild';
import { erganiUserForm, makerMark, recordMigrationFiles, stampMigrationFiles } from '../src/assets.js';
import { VERSION } from '../src/version.js';

/**
 * THE DESKTOP BUILD — the program as the installers carry it, from this source tree:
 *
 *   <out>/launcher.mjs          the launcher (src/update/launcher.ts): never updates itself
 *   <out>/app/app.mjs           the program: ONE file — the code, zod and the QR library, the SQL migrations and the
 *                               maker's mark (src/assets.ts is replaced by a module that carries them)
 *   <out>/app/version.json      {version, node}: the version, and the Node.js the installers carry (packaging/node.json)
 *   <out>/licenses/             EUPL-1.2, NOTICE, and the notices of what the bundle includes
 *
 * The runtime itself (Node.js's own binary) is added per system by the release workflow. Run:
 *   node --import tsx scripts/build.ts [--out dist/desktop]
 */
const root = resolve(new URL('..', import.meta.url).pathname);
const { values } = parseArgs({ options: { out: { type: 'string', default: join(root, 'dist', 'desktop') } } });
const out = resolve(values.out!);
const node = JSON.parse(readFileSync(join(root, 'packaging', 'node.json'), 'utf8')) as { version: string };

const assets = [
  `export const recordMigrationFiles = () => ${JSON.stringify(recordMigrationFiles())};`,
  `export const stampMigrationFiles = () => ${JSON.stringify(stampMigrationFiles())};`,
  `export const makerMark = () => ${JSON.stringify(makerMark())};`,
  `export const erganiUserForm = () => ${JSON.stringify(erganiUserForm())};`,
].join('\n');
const inlineAssets: Plugin = {
  name: 'inline-assets',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]assets\.ts$/ }, () => ({ contents: assets, loader: 'js' }));
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'eof',
  logLevel: 'warning',
  // A bundled CommonJS package that asks for a Node built-in finds `require` here.
  banner: { js: "// SPDX-License-Identifier: EUPL-1.2\nimport { createRequire as __karta_require } from 'node:module';\nconst require = __karta_require(import.meta.url);" },
} as const;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'app'), { recursive: true });
await build({ ...common, entryPoints: [join(root, 'src', 'cli.ts')], outfile: join(out, 'app', 'app.mjs'), plugins: [inlineAssets] });
await build({ ...common, entryPoints: [join(root, 'src', 'update', 'launcher-cli.ts')], outfile: join(out, 'launcher.mjs') });
writeFileSync(join(out, 'app', 'version.json'), `${JSON.stringify({ version: VERSION, node: node.version })}\n`);

mkdirSync(join(out, 'licenses'));
copyFileSync(join(root, 'LICENSE'), join(out, 'licenses', 'LICENSE-EUPL-1.2.txt'));
copyFileSync(join(root, 'NOTICE'), join(out, 'licenses', 'NOTICE.txt'));
const qr = readFileSync(join(root, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js'), 'utf8').split('\n').slice(0, 16).join('\n');
writeFileSync(
  join(out, 'licenses', 'THIRD-PARTY-NOTICES.txt'),
  [
    'Κάρτα Εργασίας includes the following software, each under its own licence.',
    '',
    '── zod ─────────────────────────────────────────────',
    readFileSync(join(root, 'node_modules', 'zod', 'LICENSE'), 'utf8'),
    '── qrcode-generator (MIT) ──────────────────────────',
    qr,
    '',
    '── Node.js ─────────────────────────────────────────',
    'The Node.js runtime is distributed with its own LICENSE file, beside it (licenses/LICENSE-node.txt).',
    '',
  ].join('\n'),
);
console.log(`built ${VERSION} (Node.js ${node.version}) into ${out}`);
