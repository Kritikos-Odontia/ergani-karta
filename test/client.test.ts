// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErganiClient,
  ErganiError,
  ErganiRateLimitedError,
  RATE_LIMIT_BACKOFF_MS,
  type Transport,
} from '../src/ergani/client.js';
import { loadConfig, Secret, type Config } from '../src/config.js';
import {
  ENARXI,
  SubmissionResult,
  WORK_CARD_CODE,
  WorkCardSubmission,
} from '../src/ergani/types.js';
import {
  ACCESS_TOKEN_LIFETIME_S,
  FAKE_CREDENTIAL,
  MEASURED_NOW,
  fakeClientConfig,
  startErganiFake,
  wrongEmployerMessage,
  type ErganiFake,
  type ErganiFakeOptions,
} from './fake/ergani-fake.js';
import { AFM } from './fixtures/people.js';

/**
 * ⚠ Every identifier here is FABRICATED, and every call goes to a fake — a scripted transport, or the
 * ministry-derived local fake on 127.0.0.1 (`test/fake/ergani-fake.ts`). docs/RULES.md rule 9:
 * a test that reached production would file a real declaration about a real person, and no test
 * reaches any ΕΡΓΑΝΗ host, trial included. The runtime fence in `test/setup.ts` enforces that
 * independently of this file.
 */
const config: Config = loadConfig({
  ERGANI_EMPLOYER_AFM: AFM.employer,
  ERGANI_BRANCH_0_USERNAME: 'fixture01',
  ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
  ERGANI_USERTYPE: '02',
  ERGANI_BASE_URL: 'https://fake.invalid/api',
});

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
}

/** A transport that records calls and replays queued responses. */
function fake(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const transport: Transport = ((input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization: headers['authorization'],
    });
    const next = queue.shift() ?? { status: 500, body: 'fake transport exhausted' };
    const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return Promise.resolve(
      new Response(payload, { status: next.status ?? 200, headers: next.headers ?? {} }),
    );
  }) as Transport;
  return { transport, calls };
}

const authOk = { body: { accessToken: 'tok-1', accessTokenExpired: 10800 } };

describe('authentication and token caching', () => {
  it('authenticates once and reuses the token across calls', async () => {
    // ⚠⚠ THE RULE-8 TEST. The ministry names per-call re-authentication as anti-pattern #1 and the
    // public Python SDK does exactly that; a client which inherited it would be rate-limited out of
    // a 15-minute compliance window. This asserts the cache, not merely that the call succeeds.
    const { transport, calls } = fake([authOk, { body: [] }, { body: [] }, { body: [] }]);
    const client = new ErganiClient(config, { transport });

    await client.listSubmissions();
    await client.listSubmissions();
    await client.listSubmissions();

    const auths = calls.filter((c) => c.url.endsWith('/Authentication'));
    expect(auths).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('re-authenticates once the token is near expiry', async () => {
    let now = 1_000_000;
    const { transport, calls } = fake([authOk, { body: [] }, authOk, { body: [] }]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await client.listSubmissions();
    // 10800s lifetime, 60s refresh margin — step just past the refresh point.
    now += 10_800_000 - 30_000;
    await client.listSubmissions();

    expect(calls.filter((c) => c.url.endsWith('/Authentication'))).toHaveLength(2);
  });

  it('sends the credential only to /Authentication, and bearers everywhere else', async () => {
    const { transport, calls } = fake([authOk, { body: [] }]);
    const client = new ErganiClient(config, { transport });
    await client.listSubmissions();

    const auth = calls[0];
    const lookup = calls[1];
    expect(auth?.url).toBe('https://fake.invalid/api/Authentication');
    expect(auth?.body).toContain('Fixture.p1');
    expect(auth?.authorization).toBeUndefined();

    // The credential must appear in exactly one request, ever.
    expect(lookup?.authorization).toBe('Bearer tok-1');
    expect(lookup?.body).toBeUndefined();
    expect(calls.filter((c) => c.body?.includes('Fixture.p1') === true)).toHaveLength(1);
  });
});

const DAY_MS = 86_400_000;
const HOURS_3_MS = 10_800_000;

/** The guide's full sign-in answer (§2.1.1): two tokens, two lifetimes, two units. */
function signedIn(now: number, n: number) {
  return {
    body: {
      accessToken: `tok-${n}`,
      accessTokenExpired: 10800,
      refreshToken: `ref-${n}`,
      refreshTokenExpired: new Date(now + 7 * DAY_MS).toISOString(),
    },
  };
}

const path = (c: Call) => new URL(c.url).pathname.replace('/api/', '');

describe('token semantics — guide §2.1.1–2.1.3 and Παράρτημα ΙΙ', () => {
  it('refreshes on expiry with {AccessToken, RefreshToken}, never re-sending the credential', async () => {
    let now = 1_000_000;
    const { transport, calls } = fake([
      signedIn(now, 1),
      { body: [] },
      signedIn(now + HOURS_3_MS, 2),
      { body: [] },
    ]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await client.listSubmissions();
    now += HOURS_3_MS;
    await client.listSubmissions();

    expect(calls.map(path)).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Authentication/Refresh',
      'Lookup/Submissions',
    ]);
    expect(JSON.parse(calls[2]?.body ?? '')).toEqual({ AccessToken: 'tok-1', RefreshToken: 'ref-1' });
    expect(calls[3]?.authorization).toBe('Bearer tok-2');
    expect(calls.filter((c) => c.body?.includes('Fixture.p1') === true)).toHaveLength(1);
  });

  it('signs in afresh once the refresh token’s seven days are spent', async () => {
    let now = 1_000_000;
    const { transport, calls } = fake([signedIn(now, 1), { body: [] }, authOk, { body: [] }]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await client.listSubmissions();
    now += 8 * DAY_MS;
    await client.listSubmissions();

    expect(calls.map(path)).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Authentication',
      'Lookup/Submissions',
    ]);
  });

  it('signs in afresh when refresh answers 401 — the ministry’s own step 3', async () => {
    let now = 1_000_000;
    const { transport, calls } = fake([
      signedIn(now, 1),
      { body: [] },
      { status: 401, body: '' },
      authOk,
      { body: [] },
    ]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await client.listSubmissions();
    now += HOURS_3_MS;
    await expect(client.listSubmissions()).resolves.toEqual([]);

    expect(calls.map(path)).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Authentication/Refresh',
      'Authentication',
      'Lookup/Submissions',
    ]);
  });

  it('believes a 401 over its own clock: renews, then repeats the failed call once', async () => {
    const now = 1_000_000;
    const { transport, calls } = fake([
      signedIn(now, 1),
      { status: 401, body: '' },
      signedIn(now, 2),
      { body: [] },
    ]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await expect(client.listSubmissions()).resolves.toEqual([]);
    expect(calls.map(path)).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Authentication/Refresh',
      'Lookup/Submissions',
    ]);
    expect(calls[3]?.authorization).toBe('Bearer tok-2');
  });

  it('honours the api-token-expired header whatever status rides with it', async () => {
    // The guide documents the header as THE expiry signal in its own right (§2.1.1), separately from
    // the 401 of Παράρτημα ΙΙ. Tested on a status that is not 401, so the header alone must trigger it.
    const now = 1_000_000;
    const { transport, calls } = fake([
      signedIn(now, 1),
      { status: 403, body: '', headers: { 'api-token-expired': 'true' } },
      signedIn(now, 2),
      { body: [] },
    ]);
    const client = new ErganiClient(config, { transport, now: () => now });

    await expect(client.listSubmissions()).resolves.toEqual([]);
    expect(calls.map(path)).toContain('Authentication/Refresh');
  });

  it('does not loop when the renewed token is refused as well', async () => {
    const now = 1_000_000;
    const { transport, calls } = fake([
      signedIn(now, 1),
      { status: 401, body: '' },
      signedIn(now, 2),
      { status: 401, body: 'still no' },
    ]);
    const client = new ErganiClient(config, { transport, now: () => now });

    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).status).toBe(401);
    expect(calls).toHaveLength(4);
  });
});

describe('429 Too Many Requests — documented, Παράρτημα ΙΙ §3', () => {
  function recordingSleep() {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    return { sleeps, sleep };
  }

  it('waits and asks again — for sign-in exactly as for any other call', async () => {
    const { sleeps, sleep } = recordingSleep();
    const { transport, calls } = fake([
      { status: 429, body: '' },
      authOk,
      { status: 429, body: '' },
      { status: 429, body: '' },
      { body: [] },
    ]);
    const client = new ErganiClient(config, { transport, sleep });

    await expect(client.listSubmissions()).resolves.toEqual([]);
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([
      RATE_LIMIT_BACKOFF_MS[0],
      RATE_LIMIT_BACKOFF_MS[0],
      RATE_LIMIT_BACKOFF_MS[1],
    ]);
  });

  it('gives up with its own error once the backoff is spent, body kept verbatim', async () => {
    const { sleeps, sleep } = recordingSleep();
    const body = JSON.stringify({ message: 'Υπέρβαση ορίου κλήσεων.' });
    const refusals = Array.from({ length: RATE_LIMIT_BACKOFF_MS.length + 1 }, () => ({
      status: 429,
      body,
    }));
    const { transport, calls } = fake([authOk, ...refusals, { body: [] }]);
    const client = new ErganiClient(config, { transport, sleep });

    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiRateLimitedError);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).status).toBe(429);
    expect((err as ErganiError).body).toBe(body);
    expect(sleeps).toEqual([...RATE_LIMIT_BACKOFF_MS]);
    // The gaps grow — a tight loop is the misuse the limit is there to catch.
    sleeps.slice(1).forEach((ms, i) => expect(ms).toBeGreaterThan(sleeps[i] ?? Infinity));
    // Stopped: the queued success after the last refusal was never asked for.
    expect(calls).toHaveLength(1 + refusals.length);
  });
});

describe('errors', () => {
  it('keeps the free-text Greek body verbatim rather than classifying it', async () => {
    // ⚠ ΕΡΓΑΝΗ returns HTTP 400 with a Greek sentence and no code. The body is the only evidence of
    // what went wrong, and it must survive to a human unaltered — docs/RULES.md rule 8.
    const greek = 'Δεν βρέθηκε εργαζόμενος με τον συγκεκριμένο ΑΦΜ.';
    const { transport } = fake([authOk, { status: 400, body: greek }]);
    const client = new ErganiClient(config, { transport });

    // One call, one assertion pass: the token is cached after the first auth, so calling twice
    // would exhaust the fake's queue on the second lookup and assert against the wrong response.
    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).body).toBe(greek);
    expect((err as ErganiError).status).toBe(400);
    // The Greek sentence survives into the message a human will actually read.
    expect((err as ErganiError).message).toContain(greek);
  });

  it('lifts the sentence out of {"message": …} for a human, and keeps the body verbatim', async () => {
    // The documented failure, byte for byte (guide §2.1.6): a JSON field whose sentence carries a
    // literal backslash-n — two characters, kept as they came.
    const sentence = 'Για το Παράρτημα: 0\\nΤο ΑΦΜ δεν αντιστοιχεί στον συνδεδεμένο εργοδότη.';
    const body = JSON.stringify({ message: sentence });
    const { transport } = fake([authOk, { status: 400, body }]);

    const err = await new ErganiClient(config, { transport }).listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).body).toBe(body);
    expect((err as ErganiError).ministryMessage).toBe(sentence);
    expect((err as ErganiError).message).toContain(sentence);
  });

  it('surfaces an authentication failure without echoing the password', async () => {
    const { transport } = fake([{ status: 401, body: 'Λάθος στοιχεία σύνδεσης.' }]);
    const client = new ErganiClient(config, { transport });

    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    // The thrown message carries the RESPONSE, never the request we sent.
    expect(`${(err as ErganiError).message}${JSON.stringify(err)}`).not.toContain('Fixture.p1');
    expect((err as ErganiError).status).toBe(401);
  });

  it('does not cache a token when authentication fails', async () => {
    const { transport } = fake([{ status: 401, body: 'no' }]);
    const client = new ErganiClient(config, { transport });
    await client.listSubmissions().catch(() => undefined);
    expect(client.hasCachedToken).toBe(false);
  });
});

describe('reads', () => {
  it('accepts a bare array or a wrapped one, because the ministry may wrap it', async () => {
    const row = { code: 'WRKCardSE', id: 82, description: 'Δήλωση έναρξης/λήξης εργασίας' };

    const bare = fake([authOk, { body: [row] }]);
    await expect(new ErganiClient(config, { transport: bare.transport }).listSubmissions()).resolves
      .toHaveLength(1);

    const wrapped = fake([authOk, { body: { items: [row] } }]);
    const got = await new ErganiClient(config, {
      transport: wrapped.transport,
    }).listSubmissions();
    expect(got[0]?.code).toBe('WRKCardSE');
  });

  it('keeps unknown fields instead of stripping them', async () => {
    // ⚠ An undocumented field is a signal, not noise — EX_BASE_05/07/08 shipped with no docs at all.
    // Stripping would make the next such change invisible.
    const { transport } = fake([authOk, { body: [{ code: 'X', somethingNew: 'keep me' }] }]);
    const got = await new ErganiClient(config, { transport }).listSubmissions();
    expect((got[0] as Record<string, unknown>)['somethingNew']).toBe('keep me');
  });

  it('asks for the schema, which is not a read-back of filed data', async () => {
    const { transport, calls } = fake([authOk, { body: { fields: [] } }]);
    await new ErganiClient(config, { transport }).describeSubmission();
    expect(calls[1]?.url).toBe('https://fake.invalid/api/Documents/WRKCardSE');
    expect(calls[1]?.method).toBe('GET');
  });

  it('posts a service code to ExecuteService', async () => {
    const { transport, calls } = fake([authOk, { body: {} }]);
    await new ErganiClient(config, { transport }).executeService('EX_BASE_07', { afm: '123' });
    expect(calls[1]?.url).toBe('https://fake.invalid/api/WebServices/ExecuteService');
    expect(calls[1]?.body).toContain('EX_BASE_07');
  });

  it('hands over the literal `null` as null, and an empty body as undefined — never the one for the other', async () => {
    // EX_BASE_07's measured «no stamps» is the four characters `null`; an empty body was never seen (exbase.ts).
    const { transport } = fake([authOk, { body: 'null' }, { body: '' }]);
    const client = new ErganiClient(config, { transport });
    await expect(client.executeService('EX_BASE_07')).resolves.toBeNull();
    await expect(client.executeService('EX_BASE_07')).resolves.toBeUndefined();
  });
});

describe('url building', () => {
  it('tolerates a trailing slash on the base url', async () => {
    const { transport, calls } = fake([authOk, { body: [] }]);
    const c = loadConfig({
      ERGANI_EMPLOYER_AFM: AFM.employer,
      ERGANI_BRANCH_0_USERNAME: 'fixture01',
      ERGANI_BRANCH_0_PASSWORD: 'Fixture.p1',
      ERGANI_USERTYPE: '02',
      ERGANI_BASE_URL: 'https://fake.invalid/api/',
    });
    await new ErganiClient(c, { transport }).listSubmissions();
    expect(calls[0]?.url).toBe('https://fake.invalid/api/Authentication');
  });
});

/**
 * The same client against the ministry-derived fake: a real HTTP exchange with a server that follows
 * the guide and the 2026-09-24 measurements, where the tests above replay canned answers.
 * ⚠ Green here proves the DOCUMENTED protocol, not the live system — see the fake's docblock.
 */
describe('against the ministry-derived fake — test/fake/ergani-fake.ts', () => {
  let fake: ErganiFake | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function start(options: ErganiFakeOptions = {}, client: ConstructorParameters<typeof ErganiClient>[1] = {}) {
    const started = await startErganiFake(options);
    fake = started;
    return { fake: started, client: new ErganiClient(fakeClientConfig(started), client) };
  }

  const routes = () => fake?.requests.map((r) => r.route);

  /** Built through our own types, as a caller would. The ΑΦΜ and names are ministry example values. */
  const card = (employer: string) =>
    WorkCardSubmission.parse({
      Cards: {
        Card: [
          {
            f_afm_ergodoti: employer,
            f_aa: '0',
            Details: {
              CardDetails: [
                {
                  f_afm: '000000000',
                  f_eponymo: 'ΤΕΣΤ',
                  f_onoma: 'ΤΕΣΤ',
                  f_type: ENARXI,
                  f_reference_date: '2026-09-24',
                  f_date: '2026-09-24T09:00:00+03:00',
                },
              ],
            },
          },
        ],
      },
    });

  it('happy path: signs in once, finds WRKCardSE by its code, reads the seven-field schema and the services', async () => {
    const { client } = await start();

    const forms = await client.listSubmissions();
    expect(forms.some((f) => f.code === WORK_CARD_CODE)).toBe(true);
    const schema = (await client.describeSubmission()) as {
      Cards: { Card: Array<{ Details: { CardDetails: Array<Record<string, unknown>> } }> };
    };
    expect(Object.keys(schema.Cards.Card[0]?.Details.CardDetails[0] ?? {})).toEqual([
      'f_afm',
      'f_eponymo',
      'f_onoma',
      'f_type',
      'f_reference_date',
      'f_date',
      'f_aitiologia',
    ]);
    const services = (await client.listServices()) as Array<{ name: string }>;
    expect(services.map((s) => s.name)).toContain('EX_BASE_07');

    expect(routes()).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Documents/WRKCardSE',
      'WebServices/ServicesList',
    ]);
  });

  it('files a card built from our own types and gets the documented array of receipts', async () => {
    const { fake, client } = await start();
    const receipts = await client.submitWorkCard(card(fake.employerAfm));
    expect(SubmissionResult.parse(receipts)).toEqual([
      { id: '1', protocol: 'ΕΥΣ1', submitDate: '24/09/2026 10:00' },
    ]);
  });

  it('400: another employer’s ΑΦΜ gets the guide’s sentence, lifted out for a human and kept verbatim', async () => {
    const { client } = await start();
    const err = await client.submitWorkCard(card('999999999')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).status).toBe(400);
    expect((err as ErganiError).ministryMessage).toBe(wrongEmployerMessage('0'));
    expect((err as ErganiError).body).toBe(JSON.stringify({ message: wrongEmployerMessage('0') }));
  });

  it('401: when the ministry’s clock says the token is spent, it refreshes and repeats the call once', async () => {
    let ministryNow = MEASURED_NOW;
    const { client } = await start({ now: () => ministryNow }, { now: () => MEASURED_NOW });

    await client.listSubmissions();
    ministryNow += ACCESS_TOKEN_LIFETIME_S * 1000; // theirs has moved; ours has not
    await expect(client.listSubmissions()).resolves.not.toEqual([]);

    expect(routes()).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Lookup/Submissions',
      'Authentication/Refresh',
      'Lookup/Submissions',
    ]);
    expect(fake?.requests.filter((r) => r.body.includes(FAKE_CREDENTIAL.password))).toHaveLength(1);
  });

  it('401: with the refresh token past its seven days as well, it signs in afresh', async () => {
    let ministryNow = MEASURED_NOW;
    const { client } = await start({ now: () => ministryNow }, { now: () => MEASURED_NOW });

    await client.listSubmissions();
    ministryNow += 8 * 86_400_000;
    await expect(client.listSubmissions()).resolves.not.toEqual([]);

    expect(routes()).toEqual([
      'Authentication',
      'Lookup/Submissions',
      'Lookup/Submissions',
      'Authentication/Refresh',
      'Authentication',
      'Lookup/Submissions',
    ]);
  });

  it('401: a wrong credential is surfaced, never echoed, and never cached', async () => {
    const started = await startErganiFake();
    fake = started;
    const client = new ErganiClient(fakeClientConfig(started, { erganiPassword: new Secret('Wrong.pass1') }));

    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiError);
    expect((err as ErganiError).status).toBe(401);
    const shown = `${(err as ErganiError).message}${JSON.stringify(err)}`;
    expect(shown).not.toContain('Wrong.pass1');
    expect(shown).not.toContain(FAKE_CREDENTIAL.password);
    expect(client.hasCachedToken).toBe(false);
  });

  it('429: waits and asks again — sign-in included — then carries on', async () => {
    const sleeps: number[] = [];
    const { fake, client } = await start({}, { sleep: async (ms) => void sleeps.push(ms) });
    fake.throttleNext(2);

    await expect(client.listSubmissions()).resolves.not.toEqual([]);
    expect(sleeps).toEqual([RATE_LIMIT_BACKOFF_MS[0], RATE_LIMIT_BACKOFF_MS[1]]);
    expect(routes()).toEqual(['Authentication', 'Authentication', 'Authentication', 'Lookup/Submissions']);
  });

  it('429: gives up with ErganiRateLimitedError once the backoff is spent, and asks no more', async () => {
    const { fake, client } = await start({}, { sleep: async () => undefined });
    fake.throttleNext(RATE_LIMIT_BACKOFF_MS.length + 1);

    const err = await client.listSubmissions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErganiRateLimitedError);
    expect((err as ErganiError).status).toBe(429);
    expect(fake.requests).toHaveLength(RATE_LIMIT_BACKOFF_MS.length + 1);
  });
});
