// SPDX-License-Identifier: EUPL-1.2
// A STAND-IN FOR ONE VERSION OF THE PROGRAM, for the launcher's tests (test/update-launcher.test.ts). It notes that it
// ran, then does what `<data>/behave-<its version>.json` says: write a row into the stamp store, pass its probation
// (as the program does: versions.ts `commitProbation`), switch to another version (with a snapshot of the store, as
// the updater does), hang, or end with a code. `then`: what to do on the next run instead.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'version.json'), 'utf8'));
const data = process.env.KARTA_DATA_DIR;
const versions = join(data, 'versions');
appendFileSync(join(data, 'runs.log'), `${version} launcher=${process.env.KARTA_LAUNCHER} args=${process.argv.slice(2).join(' ')} installed=${process.env.KARTA_INSTALLED_NODE} runtime=${process.env.KARTA_TEST_RUNTIME}\n`);
const behaveFile = join(data, `behave-${version}.json`);
const behave = existsSync(behaveFile) ? JSON.parse(readFileSync(behaveFile, 'utf8')) : {};
if (behave.then !== undefined) writeFileSync(behaveFile, JSON.stringify(behave.then));
const store = join(data, 'stamp', 'stamp.sqlite');

if (behave.writeRow) {
  const db = new DatabaseSync(store);
  db.prepare('INSERT INTO t (v) VALUES (?)').run(version);
  db.close();
}
if (behave.commit) {
  const pending = JSON.parse(readFileSync(join(versions, 'pending.json'), 'utf8'));
  writeFileSync(join(versions, 'previous'), `${pending.from}\n`);
  rmSync(join(versions, 'pending.json'));
}
if (behave.switchTo) {
  const snapshot = join(versions, behave.switchTo, '.snapshot');
  mkdirSync(snapshot, { recursive: true });
  if (existsSync(store)) {
    const db = new DatabaseSync(store, { readOnly: true });
    db.prepare('VACUUM INTO ?').run(join(snapshot, 'stamp.sqlite'));
    db.close();
  }
  writeFileSync(join(snapshot, 'complete'), '');
  writeFileSync(join(versions, 'pending.json'), JSON.stringify({ from: version, to: behave.switchTo, snapshot, atIso: new Date().toISOString(), ...behave.pendingExtra }));
  writeFileSync(join(versions, 'current'), `${behave.switchTo}\n`);
  process.exit(75);
}
if (behave.hang) {
  process.on('SIGTERM', () => {
    appendFileSync(join(data, 'runs.log'), `${version} got SIGTERM\n`);
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  process.exit(behave.exit ?? 0);
}
