// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient, ErganiError } from '../src/ergani/client.js';
import { SubmissionResult, WorkCardSubmission } from '../src/ergani/types.js';
import {
  ACCESS_TOKEN_LIFETIME_S,
  BRANCH_PARAMETER,
  FAKE_CREDENTIAL,
  MEASURED_ENTITLEMENT,
  MEASURED_NOW,
  NOT_ENTITLED_MESSAGE,
  OUT_OF_WINDOW_MESSAGE,
  SAMPLE_STAMPS,
  UNMEASURED_DATE_PARAMETER,
  UNMEASURED_ROWS_KEY,
  fakeClientConfig,
  startErganiFake,
  validateCardPayload,
  type ErganiFake,
  type ErganiFakeOptions,
  type ReadService,
} from './fake/ergani-fake.js';

/**
 * The ministry's own files, and the fake built from them.
 *
 * ⛔ The files under `fixtures/ministry/` are evidence (see PROVENANCE.md): a failure here is fixed in
 * our code or in the fake, never by editing a fixture.
 * ⚠ The fake proves the DOCUMENTED protocol only — its own docblock says what it cannot prove.
 */

const MINISTRY = new URL('./fixtures/ministry/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, MINISTRY), 'utf8');

/**
 * `JSON.parse`, forgiving ONLY a comma directly before `}` or `]` outside a string — the one defect in
 * the ministry's `Card.json`. Anything else wrong still throws.
 */
function parseForgivingTrailingCommas(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === '\\') {
        i += 1;
        out += text.charAt(i);
      } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (!(ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1)))) {
      out += ch;
    }
  }
  return JSON.parse(out);
}

describe('the vendored ministry files', () => {
  it('are the ministry’s bytes — each one listed, and hash-pinned, in PROVENANCE.md', () => {
    const pinned = new Map(
      [...read('PROVENANCE.md').matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)].map((m) => [m[1], m[2]]),
    );
    const files = readdirSync(MINISTRY).filter((f) => f !== 'PROVENANCE.md');
    expect(pinned.size).toBe(3);
    expect(files.sort()).toEqual([...pinned.keys()].sort());
    for (const f of files) {
      const sha = createHash('sha256').update(readFileSync(new URL(f, MINISTRY))).digest('hex');
      expect(sha, f).toBe(pinned.get(f));
    }
  });

  it('WorkCard_2submissions.json parses, satisfies our types, and meets Card_v1.xsd', () => {
    const body = JSON.parse(read('WorkCard_2submissions.json'));
    expect(validateCardPayload(body)).toEqual([]);
    expect(() => WorkCardSubmission.parse(body)).not.toThrow();
    // ⚠ Two branches of ONE employer in one POST — not a split shift, whatever the name suggests.
    const [first, second] = body.Cards.Card;
    expect(first.f_afm_ergodoti).toBe(second.f_afm_ergodoti);
    expect([first.f_aa, second.f_aa]).toEqual(['0', '1']);
  });

  it('Card.json is not strict JSON — a trailing comma — and, forgiven only that, meets both', () => {
    const text = read('Card.json');
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    const body = parseForgivingTrailingCommas(text);
    expect(validateCardPayload(body)).toEqual([]);
    expect(() => WorkCardSubmission.parse(body)).not.toThrow();
    // The forgiveness is that comma and nothing else: strict JSON comes through unchanged.
    const strict = read('WorkCard_2submissions.json');
    expect(parseForgivingTrailingCommas(strict)).toEqual(JSON.parse(strict));
  });
});

describe('Card_v1.xsd, as the fake reads it', () => {
  const base = (): any => JSON.parse(read('WorkCard_2submissions.json'));
  const event = 'Cards.Card[0].Details.CardDetails[0]';

  it('refuses each thing the schema refuses, and names where', () => {
    expect(validateCardPayload(base())).toEqual([]);
    const cases: Array<[string, (b: any) => void]> = [
      [`${event}.f_afm`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_afm = '00000000')],
      [`${event}.f_eponymo`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_eponymo = 'Ω'.repeat(51))],
      [`${event}.f_onoma`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_onoma = 'Ω'.repeat(31))],
      [`${event}.f_type`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_type = '2')],
      [`${event}.f_reference_date`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_reference_date = '2022-02-30')],
      [`${event}.f_date`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_date = '2022-05-13T09:00+03:00')],
      [`${event}.f_aitiologia`, (b) => (b.Cards.Card[0].Details.CardDetails[0].f_aitiologia = 'ΔΙΑΚΟΠΗ ΡΕΥΜΑΤΟΣ')],
      [`${event}.f_aitiologia`, (b) => delete b.Cards.Card[0].Details.CardDetails[0].f_aitiologia],
      ['Cards.Card[0].f_afm_ergodoti', (b) => (b.Cards.Card[0].f_afm_ergodoti = '0000000010')],
      ['Cards.Card[0].f_aa', (b) => (b.Cards.Card[0].f_aa = '123456')],
      ['Cards.Card[0].f_aa', (b) => (b.Cards.Card[0].f_aa = 0)],
      ['Cards.Card[0].f_comments', (b) => (b.Cards.Card[0].f_comments = 'α'.repeat(201))],
      ['Cards.Card[0].f_extra', (b) => (b.Cards.Card[0].f_extra = 'x')],
      ['Cards.Card[1].Details.CardDetails', (b) => (b.Cards.Card[1].Details.CardDetails = [])],
      ['Cards.Card', (b) => (b.Cards.Card = b.Cards.Card[0])],
    ];
    for (const [path, mutate] of cases) {
      const b = base();
      mutate(b);
      const errors = validateCardPayload(b);
      expect(
        errors.some((e) => e.startsWith(`${path}:`)),
        `${path} — got ${JSON.stringify(errors)}`,
      ).toBe(true);
    }
  });

  it('reads null as an empty value, as the guide’s own §2.1.6 request sends it', () => {
    const b = base();
    b.Cards.Card[0].Details.CardDetails[0].f_aitiologia = null;
    expect(validateCardPayload(b)).toEqual([]);
    // Empty is not a free pass: an empty ΑΦΜ still fails its pattern.
    b.Cards.Card[0].Details.CardDetails[0].f_afm = null;
    expect(validateCardPayload(b)).not.toEqual([]);
  });
});

describe('the fake, as a client meets it', () => {
  let fake: ErganiFake | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function start(options: ErganiFakeOptions = {}) {
    fake = await startErganiFake(options);
    return { fake, client: new ErganiClient(fakeClientConfig(fake)) };
  }

  const params = (code: ReadService, date: string, name = UNMEASURED_DATE_PARAMETER[code]) => ({
    Parameters: [
      { ParameterName: name, ParameterValue: date },
      { ParameterName: BRANCH_PARAMETER, ParameterValue: '0' },
    ],
  });

  const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ErganiError);

  it('ServicesList is the measured catalogue: no EX_BASE_04, and 07/08 declare a Date and PararthmaAa', async () => {
    const { client } = await start();
    const services = (await client.listServices()) as Array<{
      name: string;
      parameters: Array<{ name: string; type: string; isRequired: boolean }>;
    }>;
    expect(services.map((s) => s.name)).toEqual([...MEASURED_ENTITLEMENT]);
    expect(services.map((s) => s.name)).not.toContain('EX_BASE_04');
    for (const code of ['EX_BASE_07', 'EX_BASE_08'] as const) {
      const declared = services.find((s) => s.name === code)?.parameters ?? [];
      expect(declared.map((p) => [p.name, p.type, p.isRequired])).toEqual([
        [UNMEASURED_DATE_PARAMETER[code], 'Date', true],
        [BRANCH_PARAMETER, 'Int', true],
      ]);
    }
  });

  it('the read window, as measured on 24/09/2026: this month and later refused, last month answers', async () => {
    const { client } = await start();
    for (const date of ['24/09/2026', '01/09/2026', '01/10/2026']) {
      const err = await refusal(client.executeService('EX_BASE_07', params('EX_BASE_07', date)));
      expect(err, date).toBeInstanceOf(ErganiError);
      expect(err?.status, date).toBe(400);
      expect(err?.ministryMessage, date).toBe(OUT_OF_WINDOW_MESSAGE);
    }
    for (const date of ['31/08/2026', '15/07/2026']) {
      await expect(client.executeService('EX_BASE_08', params('EX_BASE_08', date)), date).resolves.toBeDefined();
    }
  });

  it('turns the month on the Athens calendar, not UTC', async () => {
    // Both instants are 30/09 in UTC. Only the second is already October in Athens.
    for (const [instant, accepted] of [
      ['2026-09-30T20:30:00Z', false],
      ['2026-09-30T21:30:00Z', true],
    ] as const) {
      const { client } = await start({ now: () => Date.parse(instant) });
      const err = await refusal(client.executeService('EX_BASE_07', params('EX_BASE_07', '30/09/2026')));
      expect(err === undefined, instant).toBe(accepted);
      await fake?.close();
    }
    fake = undefined;
  });

  it('answers in the measured pattern — a night-shift flag in 07, a leave day with no hour fields in 08, a bare null for an empty 07 day', async () => {
    const { client } = await start();
    await expect(client.executeService('EX_BASE_07', params('EX_BASE_07', '28/08/2026'))).resolves.toEqual({
      EX_BASE_07: { [UNMEASURED_ROWS_KEY.EX_BASE_07]: SAMPLE_STAMPS['28/08/2026'] },
    });
    expect(SAMPLE_STAMPS['28/08/2026']?.[0]?.IsEndDateDifferentThanDate).toBe('1');

    const schedule = (await client.executeService('EX_BASE_08', params('EX_BASE_08', '31/08/2026'))) as Record<
      string,
      Record<string, Array<Record<string, string>>>
    >;
    const rows = schedule['EX_BASE_08']?.[UNMEASURED_ROWS_KEY.EX_BASE_08] ?? [];
    // Measured 2026-09-28: a leave row has no hour fields and no Extra; a working row has HH:MM:SS hours and Extra null.
    expect(rows.some((r) => r['Type'] === 'ΑΔΠΠΜ' && !('HourFrom' in r) && !('HourTo' in r) && !('Extra' in r))).toBe(true);
    expect(rows.some((r) => r['Type'] === 'ΕΡΓ' && r['HourFrom'] === '08:00:00' && r['Extra'] === null)).toBe(true);
    expect(rows.every((r) => r['Date'] === '31/08/2026' && r['aa'] === '0')).toBe(true);

    // Measured 2026-09-28: a day with no stamps is answered with a bare null.
    await expect(client.executeService('EX_BASE_07', params('EX_BASE_07', '15/07/2026'))).resolves.toBeNull();
  });

  it('refuses a misnamed or malformed parameter, rather than answering a month with no stamps', async () => {
    const { client } = await start();
    for (const body of [
      params('EX_BASE_07', '31/08/2026', 'Date'),
      { Parameters: [...params('EX_BASE_07', '31/08/2026').Parameters, { ParameterName: 'Afm', ParameterValue: '000000000' }] },
      params('EX_BASE_07', '2026-08-31'),
      { Parameters: [{ ParameterName: BRANCH_PARAMETER, ParameterValue: '0' }] },
      {},
    ]) {
      const err = await refusal(client.executeService('EX_BASE_07', body));
      expect(err?.status, JSON.stringify(body)).toBe(400);
      expect(err?.ministryMessage, JSON.stringify(body)).toMatch(/^ergani-fake: /);
    }
  });

  it('answers a spent access token with 401 AND the documented api-token-expired: true header', async () => {
    // Asserted on the raw exchange: the client renews on a bare 401 as well, so only this sees the header.
    let now = MEASURED_NOW;
    const { fake } = await start({ now: () => now });
    const auth = await fetch(`${fake.baseUrl}/Authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Username: FAKE_CREDENTIAL.username,
        Password: FAKE_CREDENTIAL.password,
        Usertype: FAKE_CREDENTIAL.usertype,
      }),
    });
    const { accessToken } = (await auth.json()) as { accessToken: string };
    const lookup = () =>
      fetch(`${fake.baseUrl}/Lookup/Submissions`, { headers: { authorization: `Bearer ${accessToken}` } });

    expect((await lookup()).status).toBe(200);
    now += ACCESS_TOKEN_LIFETIME_S * 1000;
    const spent = await lookup();
    expect(spent.status).toBe(401);
    expect(spent.headers.get('api-token-expired')).toBe('true');
  });

  it('answers a service outside the entitlement with the guide’s 400', async () => {
    const { client } = await start();
    const err = await refusal(client.executeService('EX_BASE_04', { Parameters: [] }));
    expect(err?.status).toBe(400);
    expect(err?.ministryMessage).toBe(NOT_ENTITLED_MESSAGE);
  });

  it('lets the UNMEASURED placeholders move, so a reader can prove it learns them', async () => {
    const { client } = await start({
      dateParameter: { EX_BASE_07: 'Moved07', EX_BASE_08: 'Moved08' },
      rowsKey: { EX_BASE_07: 'Rows07', EX_BASE_08: 'Rows08' },
    });
    const services = (await client.listServices()) as Array<{ name: string; parameters: Array<{ name: string }> }>;
    expect(services.find((s) => s.name === 'EX_BASE_07')?.parameters[0]?.name).toBe('Moved07');
    await expect(
      client.executeService('EX_BASE_07', params('EX_BASE_07', '31/08/2026', 'Moved07')),
    ).resolves.toEqual({ EX_BASE_07: { Rows07: SAMPLE_STAMPS['31/08/2026'] } });
    const err = await refusal(client.executeService('EX_BASE_07', params('EX_BASE_07', '31/08/2026')));
    expect(err?.status).toBe(400);
  });

  it('files the ministry’s own two-branch example for its employer: one receipt per Card', async () => {
    const example = WorkCardSubmission.parse(JSON.parse(read('WorkCard_2submissions.json')));
    const { client } = await start({ employerAfm: example.Cards.Card[0]?.f_afm_ergodoti ?? '' });
    const receipts = SubmissionResult.parse(await client.submitWorkCard(example));
    expect(receipts.map((r) => r.protocol)).toEqual(['ΕΥΣ1', 'ΕΥΣ2']);
    expect(receipts[0]?.submitDate).toBe('24/09/2026 10:00');
  });
});
