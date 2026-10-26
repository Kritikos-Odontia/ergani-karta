// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ErganiClient } from '../src/ergani/client.js';
import { ENARXI, LIXI } from '../src/ergani/types.js';
import { athensInstant } from '../src/stamp/athens.js';
import { capturePunch, type Punch } from '../src/stamp/capture.js';
import { deadlineTransport } from '../src/stamp/deadline.js';
import { attemptsOf, decide, Outbox, type OutboxOptions, stateOfPunch } from '../src/stamp/outbox.js';
import { checkPin, chooseOwnPin, type VerifiedPerson } from '../src/stamp/staff.js';
import { initStampStore, openStampStore } from '../src/stamp/store.js';
import { branchLogin, fakeBranchConfig, startErganiFake, type ErganiFake } from './fake/ergani-fake.js';
import { AFM, ALFA, VITA } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';

// These tests catch draining an old snapshot before checking a fresh card, and promoting a ΛΗΞΗ ahead of its due
// ΕΝΑΡΞΗ. Slow sends advance a controlled clock; the real client still files only to the fenced local fake.
let clock = athensInstant('2026-10-26', '09:00');
const now = () => clock;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  clock = athensInstant('2026-10-26', '09:00');
});

async function boot() {
  const fake: ErganiFake = await startErganiFake({ now, branchLogins: { '0': branchLogin('0'), '1': branchLogin('1') } });
  cleanup.push(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), 'ergani-queue-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'stamp.sqlite');
  const instance = { name: 'testclinic', realm: 'local' as const, employerAfm: fake.employerAfm };
  let db = initStampStore(path, instance, ['0', '1'], 'now');
  cleanup.push(() => { if (db.isOpen) db.close(); });
  const people: VerifiedPerson[] = [];
  for (const [i, fixture] of [ALFA, VITA].entries()) {
    const added = await addPersonForTest(db, fixture, 'test', clock);
    const first = await checkPin(db, added.id, added.oneTimePin!, clock);
    if (first.kind !== 'ok') throw new Error('test PIN refused');
    const chosen = await chooseOwnPin(db, first.person, i === 0 ? '2580' : '1397', clock);
    if (!chosen.ok) throw new Error(chosen.problem);
    people.push(chosen.person);
  }
  const device = deviceAt(db);
  const annex = deviceAt(db, '1', 'Δεύτερο');
  const clients = new Map(['0', '1'].map((branch) => [branch, new ErganiClient(fakeBranchConfig(fake, branch), { now, transport: deadlineTransport(globalThis.fetch, now) })]));
  let afterSend: (submission: Parameters<ErganiClient['submitWorkCard']>[0]) => void = () => undefined;
  const makeOutbox = (onEvent?: OutboxOptions['onEvent']) => new Outbox({
    db, employerAfm: fake.employerAfm, now, log: () => undefined, ...(onEvent === undefined ? {} : { onEvent }),
    clients: new Map([...clients].map(([branch, client]) => [branch, {
      async submitWorkCard(submission: Parameters<ErganiClient['submitWorkCard']>[0]) {
        const answer = await client.submitWorkCard(submission);
        afterSend(submission);
        return answer;
      },
      fetchSubmissionPdf: client.fetchSubmissionPdf.bind(client),
    }])),
  });
  function approve(p: Punch) {
    decide(db, p.id, { kind: 'file_late', fAitiologia: '003' }, { employeeId: undefined, label: 'test', deviceId: undefined }, clock);
  }
  const backlog = () => Array.from({ length: 8 }, (_, i) => {
    const p = capturePunch(db, people[0]!, ENARXI, device, athensInstant(`2026-10-${10 + i}`, '09:00'));
    approve(p);
    return p;
  });
  return {
    fake, get db() { return db; }, people, device, annex, approve, backlog, makeOutbox,
    afterSend(f: typeof afterSend) { afterSend = f; },
    restart() { db.close(); db = openStampStore(path, instance, ['0', '1']); return makeOutbox(); },
  };
}

it('a long outage does not auto-file expired cards; approved backlog cannot consume a fresh card\'s window', async () => {
  const t = await boot();
  const expired = capturePunch(t.db, t.people[0]!, ENARXI, t.device, athensInstant('2026-10-09', '09:00'));
  await t.makeOutbox().pass();
  expect(t.fake.filed).toHaveLength(0);
  expect(stateOfPunch(t.db, expired, clock)).toMatchObject({ kind: 'needs-human', why: 'wall' });
  const old = t.backlog();
  const fresh = capturePunch(t.db, t.people[1]!, ENARXI, t.device, clock);
  t.afterSend(() => { clock += 3 * 60_000; });
  const outbox = t.makeOutbox();
  await outbox.pass();
  expect(stateOfPunch(t.db, fresh, clock)).toMatchObject({ kind: 'filed', late: false });
  expect(attemptsOf(t.db, fresh.id)[0]!.startedMs - fresh.eventMs).toBeLessThan(60_000);
  // The backlog makes progress, one late card per pass; fresh retries never sit behind eight late sends.
  expect(old.filter((p) => stateOfPunch(t.db, p, clock).kind === 'filed')).toHaveLength(1);
  for (let i = 1; i < old.length; i++) await outbox.pass();
  expect(old.every((p) => stateOfPunch(t.db, p, clock).kind === 'filed')).toBe(true);
  expect(attemptsOf(t.db, expired.id)).toEqual([]);
});

it('rechecks fresh stamps captured while a late send is in flight before continuing the backlog', async () => {
  const t = await boot();
  t.backlog();
  let fresh: Punch | undefined;
  const outbox = t.makeOutbox();
  t.afterSend(() => {
    clock += 3 * 60_000;
    if (fresh === undefined) {
      fresh = capturePunch(t.db, t.people[1]!, ENARXI, t.device, clock);
      outbox.wake();
    }
  });
  await outbox.pass();
  expect(stateOfPunch(t.db, fresh!, clock)).toMatchObject({ kind: 'filed', late: false });
  expect(t.fake.filed.slice(0, 2).map((f) => f.detail['f_afm'])).toEqual([AFM.alfa, AFM.vita]);
});

it('across midnight and branches, promotes the fresh ΛΗΞΗ\'s due ΕΝΑΡΞΗ before it, ahead of unrelated backlog', async () => {
  const t = await boot();
  clock = athensInstant('2026-10-27', '00:05');
  t.backlog();
  const start = capturePunch(t.db, t.people[1]!, ENARXI, t.device, athensInstant('2026-10-26', '23:20'));
  t.approve(start);
  const end = capturePunch(t.db, t.people[1]!, LIXI, t.annex, clock);
  t.afterSend(() => { clock += 3 * 60_000; });
  await t.makeOutbox().pass();
  expect(end.referenceDate).toBe('2026-10-26');
  expect(t.fake.filed.slice(0, 2).map((f) => [f.detail['f_afm'], f.detail['f_type']])).toEqual([[AFM.vita, '0'], [AFM.vita, '1']]);
  expect(stateOfPunch(t.db, end, clock)).toMatchObject({ kind: 'filed', late: false });
});

it('a failed due ΕΝΑΡΞΗ never holds back its fresh ΛΗΞΗ for a late retry', async () => {
  const t = await boot();
  t.backlog();
  const start = capturePunch(t.db, t.people[1]!, ENARXI, t.device, clock - 60 * 60_000);
  t.approve(start);
  const end = capturePunch(t.db, t.people[1]!, LIXI, t.device, clock);
  t.fake.failNextFilings(1, 503);
  await t.makeOutbox().pass();
  expect(attemptsOf(t.db, start.id)).toMatchObject([{ outcome: 'failed' }]);
  expect(stateOfPunch(t.db, end, clock)).toMatchObject({ kind: 'filed' });
  expect(stateOfPunch(t.db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked', canFileLate: false });
});

it('a restart mid-backlog preserves receipts, decisions and the uncertain-send bound while prioritising new cards', async () => {
  const t = await boot();
  const old = t.backlog();
  await t.makeOutbox(() => { throw new Error('simulated stop after first durable receipt'); }).pass();
  const prior = t.fake.filed.length;
  // A later card sent before the crash may already have reached ΕΡΓΑΝΗ; the earlier ΕΝΑΡΞΗ must stay blocked.
  const start = capturePunch(t.db, t.people[1]!, ENARXI, t.device, clock - 3_600_000);
  const end = capturePunch(t.db, t.people[1]!, LIXI, t.device, clock - 30 * 60_000);
  t.approve(start);
  t.db.prepare('INSERT INTO dispatches (punch_id, at_ms) VALUES (?, ?)').run(end.id, clock - 30 * 60_000);
  const fresh = capturePunch(t.db, t.people[1]!, ENARXI, t.device, clock);
  const next = t.restart();
  t.afterSend(() => { clock += 3 * 60_000; });
  await next.pass();
  expect(t.fake.filed[prior]!.detail['f_date']).toBe(fresh.fDate);
  expect(stateOfPunch(t.db, fresh, clock)).toMatchObject({ kind: 'filed', late: false });
  expect(attemptsOf(t.db, old[0]!.id)).toHaveLength(1);
  expect(stateOfPunch(t.db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked' });
  expect(attemptsOf(t.db, start.id)).toEqual([]);
});
