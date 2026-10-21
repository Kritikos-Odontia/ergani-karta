// SPDX-License-Identifier: EUPL-1.2
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient } from '../src/ergani/client.js';
import { adminCommand } from '../src/stamp/admin.js';
import { athensInstant } from '../src/stamp/athens.js';
import { createEnrollment, ENROLLMENT_TTL_MS, revokeDevice } from '../src/stamp/devices.js';
import { LAST_SEND_MS, Outbox } from '../src/stamp/outbox.js';
import { APP_JS } from '../src/stamp/page.js';
import { createStampServer, HEALTHY_PASS_MS } from '../src/stamp/server.js';
import { capturePunch } from '../src/stamp/capture.js';
import { addPerson, checkPin, chooseOwnPin } from '../src/stamp/staff.js';
import { initStampStore, openStampStore, type Instance, type StampStore } from '../src/stamp/store.js';
import { branchLogin, fakeBranchConfig, fakeClientConfig, startErganiFake, type ErganiFake } from './fake/ergani-fake.js';
import { AFM, ALFA, VITA } from './fixtures/people.js';
import { addPersonForTest, deviceAt, outboxFor } from './fixtures/staff.js';

/**
 * The reception page's server and the owner's tool, end to end against the ministry-derived fake.
 * ⛔ Fabricated ΑΦΜ and names only. Every request goes to 127.0.0.1.
 */

const PERSON = ALFA;
let clock = athensInstant('2026-10-05', '09:00');
const now = () => clock;
let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
  clock = athensInstant('2026-10-05', '09:00');
});

async function boot() {
  const fake: ErganiFake = await startErganiFake({ now });
  cleanup.push(() => fake.close());
  const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
  const db: StampStore = initStampStore(':memory:', instance, ['0'], 'now');
  cleanup.push(() => db.close());
  const client = new ErganiClient(fakeClientConfig(fake), { now });
  const outbox = outboxFor({ db, client, instance, now, log: () => undefined });
  const server: Server = createStampServer({
    db,
    hooks: { outbox },
    instance: 'testclinic',
    branches: [{ code: '0', heading: 'Οδοντιατρείο Δοκιμής', inspectorateEmail: 'inspectorate@example.invalid' }],
    cookieSecure: false,
    now,
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fake, db, outbox, base };
}

async function enrol(db: StampStore, base: string): Promise<string> {
  const token = createEnrollment(db, '0', 'Υποδοχή', clock);
  const res = await fetch(`${base}/enroll/${token}`, { redirect: 'manual' });
  expect(res.status).toBe(303);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(';')[0]!;
}

/** A JSON answer, loosely typed: the tests assert its shape. */
async function json(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}

function post(base: string, path: string, body: unknown, cookie: string, origin = base) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify(body),
  });
}

describe('who may see the page', () => {
  it('shows nothing to a device that is not enrolled — no names, no board', async () => {
    const { db, base } = await boot();
    await addPersonForTest(db, PERSON, 'test', clock);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(403);
    const text = await page.text();
    expect(text).toContain('δεν είναι εγγεγραμμένη');
    expect(text).not.toContain('Άλφα');
    expect((await fetch(`${base}/api/board`)).status).toBe(403);
    expect((await fetch(`${base}/api/board`, { headers: { cookie: 'ergani_device_testclinic=forged' } })).status).toBe(403);
  });

  it('shows the maker\'s label at the foot of the page, enrolled or not, with the mark served by the page itself', async () => {
    const { db, base } = await boot();
    const stranger = await (await fetch(`${base}/`)).text();
    expect(stranger).toContain('<footer class="made-by"><img src="/odontia-mark.svg" alt="" width="18" height="18">Φτιαγμένο από την Odontia</footer>');
    const cookie = await enrol(db, base);
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toContain('Φτιαγμένο από την Odontia');
    const mark = await fetch(`${base}/odontia-mark.svg`);
    expect(mark.status).toBe(200);
    expect(mark.headers.get('content-type')).toBe('image/svg+xml');
    expect(await mark.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('enrols a device once, with a link that works once and expires', async () => {
    const { db, base } = await boot();
    const token = createEnrollment(db, '0', 'Υποδοχή', clock);
    expect((await fetch(`${base}/enroll/${token}`, { redirect: 'manual' })).status).toBe(303);
    expect((await fetch(`${base}/enroll/${token}`, { redirect: 'manual' })).status).toBe(404);
    const late = createEnrollment(db, '0', 'Υποδοχή', clock);
    clock += ENROLLMENT_TTL_MS;
    expect((await fetch(`${base}/enroll/${late}`, { redirect: 'manual' })).status).toBe(404);
  });

  it('sends an enrolled device its cookie again, at most once a day — a browser keeps a cookie 400 days at most', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const board = () => fetch(`${base}/api/board`, { headers: { cookie } });
    const first = await board();
    expect(first.status).toBe(200);
    const sent = first.headers.get('set-cookie') ?? '';
    // The same token, with a fresh lifetime of 400 days.
    expect(sent.split(';')[0]).toBe(cookie);
    expect(sent).toMatch(/; Max-Age=34560000(;|$)/);
    expect(sent).toMatch(/HttpOnly/);
    expect(sent).toMatch(/SameSite=Strict/);
    clock += 24 * 3_600_000 - 1;
    expect((await board()).headers.get('set-cookie')).toBeNull();
    clock += 1;
    expect((await board()).headers.get('set-cookie')?.split(';')[0]).toBe(cookie);
    expect((await board()).headers.get('set-cookie')).toBeNull();
    // A device that is not enrolled is sent nothing.
    expect((await fetch(`${base}/api/board`, { headers: { cookie: 'ergani_device_testclinic=forged' } })).headers.get('set-cookie')).toBeNull();
  });

  it('refuses a POST from another origin, or not as JSON', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const { id } = await addPersonForTest(db, PERSON, 'test', clock);
    expect((await post(base, '/api/pin', { employeeId: id, pin: '0000' }, cookie, 'http://evil.invalid')).status).toBe(403);
    const form = await fetch(`${base}/api/pin`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(403);
  });
});

describe('stamping at the page', () => {
  it('first use: one-time PIN → own PIN → ΕΝΑΡΞΗ → filed, and the board never carries an ΑΦΜ', async () => {
    const { db, base, outbox, fake } = await boot();
    const cookie = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);

    const board0 = await json(fetch(`${base}/api/board`, { headers: { cookie } }));
    expect(board0.staff).toEqual([{ id, name: 'Άλφα', last: null }]);

    const pin = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, cookie));
    expect(pin).toMatchObject({ ok: true, mustChooseOwn: true, suggestion: '0' });
    // Not straight to a card: the one-time PIN's ticket is only good for choosing one's own.
    expect((await post(base, '/api/stamp', { ticket: pin.ticket, type: '0' }, cookie)).status).toBe(409);

    const again = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, cookie));
    const refused = await post(base, '/api/own-pin', { ticket: again.ticket, newPin: '1234' }, cookie);
    expect(refused.status).toBe(422);
    const own = await json(post(base, '/api/own-pin', { ticket: again.ticket, newPin: '2580' }, cookie));
    expect(own).toMatchObject({ ok: true, mustChooseOwn: false });

    const card = await json(post(base, '/api/stamp', { ticket: own.ticket, type: '0' }, cookie));
    expect(card).toMatchObject({ ok: true, at: clock, referenceDate: '2026-10-05' });
    // The ticket is spent.
    expect((await post(base, '/api/stamp', { ticket: own.ticket, type: '0' }, cookie)).status).toBe(409);

    await outbox.pass();
    expect(fake.filed).toHaveLength(1);
    const state = await json(fetch(`${base}/api/card/${card.punchId}`, { headers: { cookie } }));
    expect(state).toEqual({ state: { kind: 'filed', protocol: 'ΕΥΣ1', late: false } });

    const boardText = await (await fetch(`${base}/api/board`, { headers: { cookie } })).text();
    expect(boardText).not.toContain(PERSON.afm);
    expect(boardText).not.toContain(fake.employerAfm);
    expect(JSON.parse(boardText).staff[0].last).toMatchObject({ type: '0', state: { kind: 'filed' } });
  });

  it('a refusal that quotes the employee\'s ΑΦΜ reaches the screen without it — the sentence otherwise verbatim', async () => {
    const { db, base, outbox, fake } = await boot();
    const cookie = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const first = await checkPin(db, id, oneTimePin!, clock);
    if (first.kind !== 'ok') throw new Error('PIN');
    const own = await chooseOwnPin(db, first.person, '2580', clock);
    if (!own.ok) throw new Error(own.problem);
    const card = capturePunch(db, own.person, '0', { id: 1, branch: '0' }, clock);
    fake.failNextFilings(1, 400, { message: `Το ΑΦΜ ${PERSON.afm} δεν αντιστοιχεί σε εργαζόμενο.` });
    await outbox.pass();
    const boardText = await (await fetch(`${base}/api/board`, { headers: { cookie } })).text();
    const cardText = await (await fetch(`${base}/api/card/${card.id}`, { headers: { cookie } })).text();
    for (const text of [boardText, cardText]) {
      expect(text).not.toContain(PERSON.afm);
      expect(text).toContain('Το ΑΦΜ … δεν αντιστοιχεί σε εργαζόμενο.');
    }
    // The record keeps ΕΡΓΑΝΗ's words exactly (rule 8).
    expect(db.prepare('SELECT message FROM attempts WHERE punch_id = ?').get(card.id)?.['message']).toContain(PERSON.afm);
  });

  it('answers a wrong PIN with the tries left, then locks', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const { id } = await addPersonForTest(db, PERSON, 'test', clock);
    const first = await post(base, '/api/pin', { employeeId: id, pin: '0000' }, cookie);
    expect(first.status).toBe(401);
    expect((await json(first)).triesLeft).toBe(4);
    for (let i = 0; i < 3; i++) await post(base, '/api/pin', { employeeId: id, pin: '0000' }, cookie);
    expect((await post(base, '/api/pin', { employeeId: id, pin: '0000' }, cookie)).status).toBe(423);
  });

  it('a one-time PIN typed twice gives two tickets — once she has chosen her own, the other is worth nothing (rule 1)', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const first = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, cookie));
    const second = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, cookie));
    expect((await post(base, '/api/own-pin', { ticket: first.ticket, newPin: '2580' }, cookie)).status).toBe(200);
    const stale = await post(base, '/api/own-pin', { ticket: second.ticket, newPin: '1397' }, cookie);
    expect(stale.status).toBe(422);
    // Nor an oracle: her own new PIN, tried on the stale ticket, gets the same answer as any other.
    const probe = await json(post(base, '/api/own-pin', { ticket: second.ticket, newPin: '2580' }, cookie));
    expect(probe.text).toMatch(/ήδη οριστεί/);
    expect(await checkPin(db, id, '2580', clock)).toMatchObject({ kind: 'ok', mustChooseOwn: false });
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(0);

    // And when the two arrive AT ONCE (the slow hash lets both pass the first look): one wins, the other is refused.
    const again = await addPersonForTest(db, { ...PERSON, afm: AFM.vita, displayName: 'Βήτα' }, 'test', clock);
    const t1 = await json(post(base, '/api/pin', { employeeId: again.id, pin: again.oneTimePin }, cookie));
    const t2 = await json(post(base, '/api/pin', { employeeId: again.id, pin: again.oneTimePin }, cookie));
    const raced = await Promise.all([
      post(base, '/api/own-pin', { ticket: t1.ticket, newPin: '2580' }, cookie),
      post(base, '/api/own-pin', { ticket: t2.ticket, newPin: '1397' }, cookie),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(db.prepare("SELECT count(*) AS n FROM employee_events WHERE employee_id = ? AND kind = 'pin_chosen'").get(again.id)?.['n']).toBe(1);
  });

  it('a revoked computer sees nothing and stamps nothing; a ticket lives two minutes', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const first = await checkPin(db, id, oneTimePin!, clock);
    if (first.kind !== 'ok') throw new Error('PIN');
    const own = await chooseOwnPin(db, first.person, '2580', clock);
    if (!own.ok) throw new Error(own.problem);
    const pin = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, cookie));
    clock += 2 * 60_000;
    expect((await post(base, '/api/stamp', { ticket: pin.ticket, type: '0' }, cookie)).status).toBe(409);
    const fresh = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, cookie));
    revokeDevice(db, 1, clock);
    expect((await fetch(`${base}/api/board`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(403);
    expect((await post(base, '/api/stamp', { ticket: fresh.ticket, type: '0' }, cookie)).status).toBe(403);
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(0);
  });

  it('a ticket made on one device cannot stamp from another', async () => {
    const { db, base } = await boot();
    const desk = await enrol(db, base);
    const other = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const t = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, desk));
    const own = await json(post(base, '/api/own-pin', { ticket: t.ticket, newPin: '2580' }, desk));
    expect((await post(base, '/api/stamp', { ticket: own.ticket, type: '0' }, other)).status).toBe(409);
  });

  it('a screen opened before her last card was made cannot stamp: she starts again and sees it', async () => {
    const { db, base, outbox, fake } = await boot();
    const desk = await enrol(db, base);
    const phone = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const t = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, desk));
    await post(base, '/api/own-pin', { ticket: t.ticket, newPin: '2580' }, desk);

    // Her PIN on both screens before either stamps: both show «no previous card» and suggest ΕΝΑΡΞΗ.
    const onDesk = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, desk));
    const onPhone = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, phone));
    expect([onDesk.last, onPhone.last]).toEqual([null, null]);
    expect((await post(base, '/api/stamp', { ticket: onDesk.ticket, type: '0' }, desk)).status).toBe(200);
    clock += 15_000;
    const stale = await post(base, '/api/stamp', { ticket: onPhone.ticket, type: '0' }, phone);
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe('stale');
    await outbox.pass();
    expect(fake.filed).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(1);

    // Started again: the screen shows the card, warns on a second ΕΝΑΡΞΗ — and she may still confirm one on purpose.
    const fresh = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, phone));
    expect(fresh).toMatchObject({ suggestion: '1', last: { type: '0' } });
    expect((await post(base, '/api/stamp', { ticket: fresh.ticket, type: '0' }, phone)).status).toBe(200);
    expect(db.prepare('SELECT count(*) AS n FROM punches').get()?.['n']).toBe(2);
  });

  it('the human queue: a person with their own PIN chooses the late reason; the card is filed late', async () => {
    const { db, base, outbox, fake } = await boot();
    const cookie = await enrol(db, base);
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const t = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, cookie));
    const own = await json(post(base, '/api/own-pin', { ticket: t.ticket, newPin: '2580' }, cookie));
    fake.failNextFilings(10_000, 503);
    const card = await json(post(base, '/api/stamp', { ticket: own.ticket, type: '0' }, cookie));
    await outbox.pass();
    clock += LAST_SEND_MS;
    await outbox.pass();
    const board = await json(fetch(`${base}/api/board`, { headers: { cookie } }));
    expect(board.queue).toMatchObject([{ punchId: card.punchId, name: 'Άλφα', why: 'wall', canFileLate: true }]);
    expect(board.inspectorateEmail).toBe('inspectorate@example.invalid');

    // A one-time PIN cannot decide: whoever decides is recorded, so it must be a PIN only they know.
    const newcomer = await addPersonForTest(db, VITA, 'test', clock);
    const premature = await post(
      base,
      '/api/decide',
      { punchId: card.punchId, employeeId: newcomer.id, pin: newcomer.oneTimePin, kind: 'covered' },
      cookie,
    );
    expect(premature.status).toBe(403);

    const noReason = await post(base, '/api/decide', { punchId: card.punchId, employeeId: id, pin: '2580', kind: 'file_late' }, cookie);
    expect(noReason.status).toBe(422);
    fake.failNextFilings(0, 503);
    const ok = await post(base, '/api/decide', { punchId: card.punchId, employeeId: id, pin: '2580', kind: 'file_late', reason: '001' }, cookie);
    expect(ok.status).toBe(200);
    await outbox.pass();
    expect(fake.filed.at(-1)?.detail['f_aitiologia']).toBe('001');
    const after = await json(fetch(`${base}/api/board`, { headers: { cookie } }));
    expect(after.queue).toEqual([]);
  });

  it('/health is ok only while the outbox is passing', async () => {
    const { base, outbox } = await boot();
    expect((await fetch(`${base}/health`)).status).toBe(503);
    await outbox.pass();
    expect(await (await fetch(`${base}/health`)).text()).toBe('ok');
    clock += HEALTHY_PASS_MS;
    expect((await fetch(`${base}/health`)).status).toBe(503);
  });

  it('serves the page with a strict content policy and no outside asset', async () => {
    const { db, base } = await boot();
    const cookie = await enrol(db, base);
    const res = await fetch(`${base}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toMatch(/https?:\/\//);
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    // The script is a string in page.ts: nothing else would notice a syntax error before a person at the desk did.
    expect(() => new Script(js)).not.toThrow();
    expect(js).toBe(APP_JS);
  });
});

describe('the owner\'s tool', () => {
  function env(dir: string): NodeJS.ProcessEnv {
    return {
      STAMP_INSTANCE: 'testclinic',
      STAMP_DB: join(dir, 'stamp.sqlite'),
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: 'http://127.0.0.1:9/WebservicesAPI/api',
    };
  }

  it('creates the store, adds people, enrols a device — and has no command that stamps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-admin-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: string[] = [];
    const io = { now, out: (l: string) => lines.push(l) };
    expect(await adminCommand(['init'], env(dir), io)).toBe(0);
    await expect(adminCommand(['init'], env(dir), io)).rejects.toThrow(/already exists/);
    expect(
      await adminCommand(['add', '--afm', PERSON.afm, '--surname', PERSON.surname, '--first-name', PERSON.firstName, '--display', 'Άλφα'], env(dir), io),
    ).toBe(0);
    expect(lines.join('\n')).toMatch(/One-time PIN to hand over: \d{4}/);
    await adminCommand(['add', '--afm', AFM.vita, '--surname', 'Δοκιμή', '--first-name', 'Γιατρός', '--exempt', 'οδοντίατρος'], env(dir), io);
    lines.length = 0;
    await adminCommand(['list'], env(dir), io);
    expect(lines.join('\n')).toMatch(/EXEMPT — οδοντίατρος/);
    lines.length = 0;
    await adminCommand(['enroll', '--label', 'Υποδοχή'], env(dir), io);
    expect(lines[0]).toMatch(/\/enroll\/[A-Za-z0-9_-]{40,}/);
    for (const verb of ['stamp', 'punch', 'clock-in', 'file']) {
      await expect(adminCommand([verb, '--afm', PERSON.afm], env(dir), io)).rejects.toThrow(/unknown command/);
    }
    // ⛔ The ΕΡΓΑΝΗ password is never printed.
    expect(lines.join('\n')).not.toContain('Fixture.p1');
  });

  it('writes one person\'s own cards — theirs only, with the protocol numbers — outside any code folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-history-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: string[] = [];
    const io = { now, out: (l: string) => lines.push(l) };
    const e = env(dir);
    await adminCommand(['init'], e, io);
    const db = openStampStore(e.STAMP_DB!, { name: 'testclinic', realm: 'local', employerAfm: AFM.employer }, ['0']);
    const device = deviceAt(db);
    const mine = await addPersonForTest(db, PERSON, 'test', clock);
    const other = await addPersonForTest(db, { afm: AFM.vita, surname: 'Άλλος', firstName: 'Γάμμα' }, 'test', clock);
    for (const [id, pin, own] of [[mine.id, mine.oneTimePin, '2580'], [other.id, other.oneTimePin, '1397']] as const) {
      const c = await checkPin(db, id, pin!, clock);
      if (c.kind !== 'ok') throw new Error('pin');
      const chosen = await chooseOwnPin(db, c.person, own, clock);
      if (!chosen.ok) throw new Error('pin');
      capturePunch(db, chosen.person, '0', device, clock);
    }
    db.prepare(
      "INSERT INTO attempts (punch_id, started_ms, finished_ms, f_aitiologia, outcome, http_status, protocol, ergani_id, submit_date) VALUES (1, 0, 0, '', 'filed', 200, 'ΕΥΣ7', '7', '05/10/2026 09:00')",
    ).run();
    db.close();
    const out = join(dir, 'exports');
    await adminCommand(['history', '--afm', PERSON.afm, '--from', '2026-10-01', '--to', '2026-10-31', '--out', out], e, io);
    // A new folder for this request alone, holding only its two files: the hand-over copies that folder.
    const [request] = readdirSync(out);
    expect(request).toMatch(/^kartes-1-2026-10-01-2026-10-31-\d{8}T\d{6}$/);
    expect(readdirSync(join(out, request!)).sort()).toEqual(['kartes-1-2026-10-01-2026-10-31.csv', 'kartes-1-2026-10-01-2026-10-31.html']);
    const html = readFileSync(join(out, request!, 'kartes-1-2026-10-01-2026-10-31.html'), 'utf8');
    const csv = readFileSync(join(out, request!, 'kartes-1-2026-10-01-2026-10-31.csv'), 'utf8');
    expect(html).toContain('ΕΥΣ7');
    expect(html).toContain('ΠΑΡΑΔΕΙΓΜΑ ΑΛΦΑ');
    expect(html).not.toContain('ΓΑΜΜΑ');
    expect(csv).toContain('"ΕΝΑΡΞΗ","2026-10-05T09:00:00+03:00","ΕΥΣ7"');
    expect(csv).not.toContain(AFM.vita);
    expect(csv.trim().split('\r\n')).toHaveLength(2);
    expect(lines.at(-1)).toBe(`1 cards written to ${join(out, request!)} — copy that folder alone, give it to that person only.`);
    // The other person's request, later: a second folder; the first still holds only the first person's files.
    await adminCommand(['history', '--afm', AFM.vita, '--from', '2026-10-01', '--to', '2026-10-31', '--out', out], e, io);
    expect(readdirSync(out)).toHaveLength(2);
    expect(readdirSync(join(out, request!))).toHaveLength(2);
    await expect(
      adminCommand(['history', '--afm', PERSON.afm, '--out', fileURLToPath(new URL('..', import.meta.url))], e, io),
    ).rejects.toThrow(/code folder/);
  });
});

describe('an employer with two branches — one page per branch, one store', () => {
  async function bootTwo() {
    const fake = await startErganiFake({ now, branchLogins: { '0': branchLogin('0'), '1': branchLogin('1') } });
    cleanup.push(() => fake.close());
    const instance: Instance = { name: 'testclinic', realm: 'local', employerAfm: fake.employerAfm };
    const db = initStampStore(':memory:', instance, ['0', '1'], 'now');
    cleanup.push(() => db.close());
    const outbox = new Outbox({
      db,
      clients: new Map(['0', '1'].map((b) => [b, new ErganiClient(fakeBranchConfig(fake, b), { now })] as const)),
      employerAfm: fake.employerAfm,
      now,
      log: () => undefined,
    });
    const server = createStampServer({
      db,
      hooks: { outbox },
      instance: 'testclinic',
      branches: [
        { code: '0', heading: 'Οδοντιατρείο Δοκιμής — Κέντρο', inspectorateEmail: 'kentro@example.invalid' },
        { code: '1', heading: 'Οδοντιατρείο Δοκιμής — Λιμάνι', inspectorateEmail: undefined },
      ],
      cookieSecure: false,
      now,
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const enrolAt = async (branch: string) => {
      const res = await fetch(`${base}/enroll/${createEnrollment(db, branch, 'Υποδοχή', clock)}`, { redirect: 'manual' });
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    return { fake, db, outbox, base, seat: await enrolAt('0'), annex: await enrolAt('1') };
  }

  it('each device shows its own branch: heading and Επιθεώρηση; the same staff, one PIN; its cards are its branch\'s', async () => {
    const { fake, db, outbox, base, seat, annex } = await bootTwo();
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const atSeat = await json(fetch(`${base}/api/board`, { headers: { cookie: seat } }));
    const atAnnex = await json(fetch(`${base}/api/board`, { headers: { cookie: annex } }));
    expect([atSeat.label, atSeat.inspectorateEmail]).toEqual(['Οδοντιατρείο Δοκιμής — Κέντρο', 'kentro@example.invalid']);
    expect([atAnnex.label, atAnnex.inspectorateEmail]).toEqual(['Οδοντιατρείο Δοκιμής — Λιμάνι', null]);
    expect(atAnnex.staff.map((p: { name: string }) => p.name)).toEqual(['Άλφα']);
    // She chooses her PIN at the seat and stamps at the annex with it: one PIN for every branch.
    const t = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, seat));
    await post(base, '/api/own-pin', { ticket: t.ticket, newPin: '2580' }, seat);
    const there = await json(post(base, '/api/pin', { employeeId: id, pin: '2580' }, annex));
    const card = await json(post(base, '/api/stamp', { ticket: there.ticket, type: '0' }, annex));
    await outbox.pass();
    expect(fake.filed.at(-1)?.detail['f_type']).toBe('0');
    expect(db.prepare('SELECT branch FROM punches WHERE id = ?').get(card.punchId)?.['branch']).toBe('1');
    // The other branch's page does not show that card's state, and cannot decide it.
    expect((await fetch(`${base}/api/card/${card.punchId}`, { headers: { cookie: seat } })).status).toBe(404);
    expect((await fetch(`${base}/api/card/${card.punchId}`, { headers: { cookie: annex } })).status).toBe(200);
    const elsewhere = await post(base, '/api/decide', { punchId: card.punchId, employeeId: id, pin: '0000', kind: 'covered' }, seat);
    expect(elsewhere.status).toBe(409);
    // …and asking cost her no PIN try: the wrong PIN above was never compared.
    expect(db.prepare('SELECT failed_pins FROM employees WHERE id = ?').get(id)?.['failed_pins']).toBe(0);
  });

  it('a card not through stays in its own branch\'s queue only', async () => {
    const { fake, db, outbox, base, seat, annex } = await bootTwo();
    const { id, oneTimePin } = await addPersonForTest(db, PERSON, 'test', clock);
    const t = await json(post(base, '/api/pin', { employeeId: id, pin: oneTimePin }, annex));
    const own = await json(post(base, '/api/own-pin', { ticket: t.ticket, newPin: '2580' }, annex));
    fake.failNextFilings(10_000, 503);
    const card = await json(post(base, '/api/stamp', { ticket: own.ticket, type: '0' }, annex));
    await outbox.pass();
    clock += LAST_SEND_MS;
    await outbox.pass();
    expect((await json(fetch(`${base}/api/board`, { headers: { cookie: annex } }))).queue).toMatchObject([{ punchId: card.punchId }]);
    expect((await json(fetch(`${base}/api/board`, { headers: { cookie: seat } }))).queue).toEqual([]);
  });

  it('the owner adds a branch once, and the service will not start until store and settings agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-branch-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: string[] = [];
    const io = { now, out: (l: string) => lines.push(l) };
    const one: NodeJS.ProcessEnv = {
      STAMP_INSTANCE: 'testclinic',
      STAMP_DB: join(dir, 'stamp.sqlite'),
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: 'http://127.0.0.1:9/WebservicesAPI/api',
    };
    const two: NodeJS.ProcessEnv = {
      ...one,
      ERGANI_BRANCHES: '0,1',
      ERGANI_BRANCH_1_USERNAME: 'fixture101',
      ERGANI_BRANCH_1_PASSWORD: 'Fixture.b1',
      STAMP_BRANCH_0_LABEL: 'Κέντρο',
      STAMP_BRANCH_1_LABEL: 'Λιμάνι',
    };
    await adminCommand(['init'], one, io);
    await expect(adminCommand(['list'], two, io)).rejects.toThrow('add it once with `docker compose run --rm stamp ergani admin add-branch --branch 1`, then `docker compose up -d`');
    expect(await adminCommand(['add-branch', '--branch', '1'], two, io)).toBe(0);
    await expect(adminCommand(['add-branch', '--branch', '1'], two, io)).rejects.toThrow(/already/);
    expect(await adminCommand(['list'], two, io)).toBe(0);
    // A branch is never left without its login once it is in the store.
    await expect(adminCommand(['list'], one, io)).rejects.toThrow(/has no login/);
    lines.length = 0;
    await expect(adminCommand(['enroll', '--label', 'Υποδοχή'], two, io)).rejects.toThrow(/--branch/);
    await adminCommand(['enroll', '--branch', '1', '--label', 'Υποδοχή'], two, io);
    expect(lines[0]).toMatch(/^For «Κάρτα Εργασίας — Λιμάνι»/);
  });
});
