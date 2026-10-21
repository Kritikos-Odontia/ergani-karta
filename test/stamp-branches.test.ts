// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient, pdfOfBase64Answer } from '../src/ergani/client.js';
import { ENARXI, LIXI } from '../src/ergani/types.js';
import { athensInstant } from '../src/stamp/athens.js';
import { capturePunch, suggestedType } from '../src/stamp/capture.js';
import { deadlineTransport } from '../src/stamp/deadline.js';
import { LAST_SEND_MS, Outbox, attemptsOf, decide, stateOfPunch } from '../src/stamp/outbox.js';
import { checkPin, chooseOwnPin, type VerifiedPerson } from '../src/stamp/staff.js';
import { initStampStore, type Instance, type StampStore } from '../src/stamp/store.js';
import { branchLogin, fakeBranchConfig, startErganiFake, type ErganiFake, type ErganiFakeOptions } from './fake/ergani-fake.js';
import { ALFA } from './fixtures/people.js';
import { addPersonForTest, deviceAt } from './fixtures/staff.js';

/**
 * ONE EMPLOYER, TWO BRANCHES, ONE STORE — the cards of both branches in one record, each filed with its own branch's
 * login, and rule 3's bound and the working day of a ΛΗΞΗ read across both.
 * ⓘ These are the two sequences a store per branch could not see (an ΕΝΑΡΞΗ at one branch, the ΛΗΞΗ at the other):
 * an earlier ΕΝΑΡΞΗ sent late after the later ΛΗΞΗ was filed, and a ΛΗΞΗ after midnight dated the next day.
 * ⛔ Fabricated people; the fake gives each branch its own login and refuses a card filed with another's.
 */

let clock = athensInstant('2026-10-05', '09:00');
const now = () => clock;
let fakes: ErganiFake[] = [];
let stores: StampStore[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  for (const db of stores) if (db.isOpen) db.close();
  fakes = [];
  stores = [];
  clock = athensInstant('2026-10-05', '09:00');
});

async function twoBranches(options: ErganiFakeOptions = {}) {
  const fake = await startErganiFake({ now, branchLogins: { '0': branchLogin('0'), '1': branchLogin('1') }, ...options });
  fakes.push(fake);
  const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
  const db = initStampStore(':memory:', instance, ['0', '1'], new Date(clock).toISOString());
  stores.push(db);
  const client = (branch: string) =>
    new ErganiClient(fakeBranchConfig(fake, branch), {
      now,
      transport: deadlineTransport(globalThis.fetch, now),
      sleep: async (ms) => {
        clock += ms;
      },
    });
  const outbox = new Outbox({
    db,
    clients: new Map([
      ['0', client('0')],
      ['1', client('1')],
    ]),
    employerAfm: fake.employerAfm,
    now,
    log: () => undefined,
  });
  return { fake, db, outbox, seat: deviceAt(db, '0'), annex: deviceAt(db, '1', 'Παράρτημα') };
}

async function verified(db: StampStore): Promise<VerifiedPerson> {
  const { id, oneTimePin } = await addPersonForTest(db, ALFA, 'test', clock);
  const first = await checkPin(db, id, oneTimePin!, clock);
  if (first.kind !== 'ok') throw new Error('one-time PIN refused');
  const chosen = await chooseOwnPin(db, first.person, '2580', clock);
  if (!chosen.ok) throw new Error(chosen.problem);
  return chosen.person;
}

describe('one employer, two branches, one store', () => {
  it('files each card with its own branch\'s login, as its own branch (f_aa)', async () => {
    const { fake, db, outbox, seat, annex } = await twoBranches();
    const who = await verified(db);
    const morning = capturePunch(db, who, ENARXI, seat, clock);
    await outbox.pass();
    clock = athensInstant('2026-10-05', '13:00');
    const noon = capturePunch(db, who, LIXI, annex, clock);
    await outbox.pass();
    expect([stateOfPunch(db, morning, clock).kind, stateOfPunch(db, noon, clock).kind]).toEqual(['filed', 'filed']);
    // The fake refuses a card filed with another branch's login: two filings, each through its own.
    expect(fake.filed.map((f) => f.detail['f_type'])).toEqual(['0', '1']);
    const signIns = fake.requests.filter((r) => r.route === 'Authentication').map((r) => JSON.parse(r.body).Username);
    expect(signIns).toEqual([branchLogin('0').username, branchLogin('1').username]);
  });

  it('⛔ an ΕΝΑΡΞΗ at one branch is never sent after her ΛΗΞΗ at the other was filed — rule 3, across branches', async () => {
    const { fake, db, outbox, seat, annex } = await twoBranches();
    const who = await verified(db);
    // 09:00 at the seat: ΕΡΓΑΝΗ is down for it until past its 14-minute stop.
    const start = capturePunch(db, who, ENARXI, seat, clock);
    fake.failNextFilings(10_000, 503);
    await outbox.pass();
    clock += LAST_SEND_MS + 1;
    await outbox.pass();
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'wall', canFileLate: true });
    // 13:00 at the annex: ΕΡΓΑΝΗ answers again, and her ΛΗΞΗ is filed.
    fake.failNextFilings(0, 503);
    clock = athensInstant('2026-10-05', '13:00');
    const end = capturePunch(db, who, LIXI, annex, clock);
    expect(end.referenceDate).toBe('2026-10-05');
    await outbox.pass();
    expect(stateOfPunch(db, end, clock)).toMatchObject({ kind: 'filed' });
    // The seat's ΕΝΑΡΞΗ is now held for a person — «covered» only, never sent late.
    expect(stateOfPunch(db, start, clock)).toMatchObject({ kind: 'needs-human', why: 'blocked', canFileLate: false });
    expect(() =>
      decide(db, start.id, { kind: 'file_late', fAitiologia: '003' }, { employeeId: who.employeeId, label: 'test', deviceId: seat.id }, clock),
    ).toThrow(/cannot be sent/);
    await outbox.pass();
    expect(fake.filed.map((f) => f.detail['f_type'])).toEqual(['1']);
  });

  it('a ΛΗΞΗ after midnight at the other branch keeps her ΕΝΑΡΞΗ\'s working day, and is the one suggested', async () => {
    const { db, seat, annex } = await twoBranches();
    const who = await verified(db);
    clock = athensInstant('2026-10-05', '23:00');
    capturePunch(db, who, ENARXI, seat, clock);
    clock = athensInstant('2026-10-06', '00:30');
    expect(suggestedType(db, who.employeeId, clock)).toBe(LIXI);
    const end = capturePunch(db, who, LIXI, annex, clock);
    expect(end).toMatchObject({ branch: '1', referenceDate: '2026-10-05' });
  });

  it('a card of a branch with no login is a failed attempt a person sees — the other cards are still filed', async () => {
    const { fake, db, seat, annex } = await twoBranches();
    const who = await verified(db);
    const outbox = new Outbox({
      db,
      clients: new Map([['0', new ErganiClient(fakeBranchConfig(fake, '0'), { now })]]),
      employerAfm: fake.employerAfm,
      now,
      log: () => undefined,
    });
    const elsewhere = capturePunch(db, who, ENARXI, annex, clock);
    clock += 1_000;
    const here = capturePunch(db, who, LIXI, seat, clock);
    await outbox.pass();
    expect(attemptsOf(db, elsewhere.id)).toMatchObject([{ outcome: 'failed', message: expect.stringContaining('branch 1') }]);
    expect(stateOfPunch(db, here, clock)).toMatchObject({ kind: 'filed' });
  });
});

describe('the proof PDF — the MEASURED answer shape (production, 2026-10-21)', () => {
  /** A tiny synthetic PDF — never a ministry document. */
  const synthetic = Buffer.from('%PDF-1.4\n% synthetic test proof\n%%EOF\n', 'utf8');
  const b64 = synthetic.toString('base64');

  it('reads the PDF out of the object ΕΡΓΑΝΗ answers: {message, document, documentName}', () => {
    const answer = JSON.stringify({ message: { code: 'x' }, document: b64, documentName: 'proof.pdf' });
    expect(pdfOfBase64Answer(answer)).toEqual(synthetic);
    // Whitespace or line breaks inside the Base64 change nothing.
    expect(pdfOfBase64Answer(JSON.stringify({ document: `${b64.slice(0, 8)}\n${b64.slice(8)}` }))).toEqual(synthetic);
  });

  it('keeps the %PDF- check whatever the wrapping: an object whose document is not a PDF is refused', () => {
    const html = Buffer.from('<html>no</html>').toString('base64');
    expect(() => pdfOfBase64Answer(JSON.stringify({ message: {}, document: html, documentName: 'x' }))).toThrow(/does not decode to a PDF/);
    expect(() => pdfOfBase64Answer(JSON.stringify({ message: {}, documentName: 'x' }))).toThrow(/without a «document»/);
    expect(() => pdfOfBase64Answer(JSON.stringify({ document: 42 }))).toThrow(/without a «document»/);
    expect(() => pdfOfBase64Answer('{"document": ')).toThrow(/not valid JSON/);
    expect(() => pdfOfBase64Answer(JSON.stringify({ document: '***' }))).toThrow(/not Base64/);
  });

  it('is fetched and stored when the fake answers in the measured shape (its default)', async () => {
    const { db, outbox, seat } = await twoBranches({ pdfShape: 'object' });
    const who = await verified(db);
    capturePunch(db, who, ENARXI, seat, clock);
    await outbox.pass();
    clock += 5_000;
    await outbox.pass();
    const row = db.prepare('SELECT pdf, error FROM evidence').get();
    expect(row?.['error']).toBeNull();
    expect(Buffer.from(row?.['pdf'] as Uint8Array).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
