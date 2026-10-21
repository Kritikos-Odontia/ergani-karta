// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it } from 'vitest';
import { ErganiClient, ErganiError } from '../src/ergani/client.js';
import {
  OutOfWindowError,
  ServiceDeclarationError,
  UnrecognisedAnswerError,
  assertReadableDate,
  athensDate,
  pararthmaAaOf,
  readSchedule,
  readStamps,
  type ReadClient,
} from '../src/ergani/exbase.js';
import {
  MEASURED_ENTITLEMENT,
  MEASURED_NOW,
  OUT_OF_WINDOW_MESSAGE,
  UNMEASURED_DATE_PARAMETER,
  fakeClientConfig,
  startErganiFake,
  type ErganiFake,
  type ErganiFakeOptions,
} from './fake/ergani-fake.js';

/**
 * R1 — the EX_BASE read client, against the ministry-derived fake (the end-to-end reads) and against a
 * stub client (the answer and catalogue shapes the fake does not produce).
 * ⚠ Green here proves the DOCUMENTED protocol and the 2026-09-24 measurements, not the live system — the
 * Date parameter's name and the rows key are the fake's UNMEASURED placeholders on purpose.
 * ⛔ Every ΑΦΜ is a ministry example value.
 */

const refusal = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe('against the ministry-derived fake', () => {
  let fake: ErganiFake | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function start(options: ErganiFakeOptions = {}, clientNow: () => number = options.now ?? (() => MEASURED_NOW)) {
    const started = await startErganiFake(options);
    fake = started;
    return { fake: started, client: new ErganiClient(fakeClientConfig(started), { now: clientNow }) };
  }

  const executed = () =>
    (fake?.requests ?? [])
      .filter((r) => r.route === 'WebServices/ExecuteService')
      .map((r) => JSON.parse(r.body) as unknown);

  it('reads EX_BASE_07 for one date — the Date parameter named as ServicesList declares it, DD/MM/YYYY, PararthmaAa "0"', async () => {
    const { client } = await start();
    await expect(readStamps(client, '2026-08-31')).resolves.toEqual([
      { Afm: '000000000', Date: '31/08/2026', HourFrom: '08:00', HourTo: '16:00', IsEndDateDifferentThanDate: false },
    ]);
    expect(executed()).toEqual([
      {
        ServiceCode: 'EX_BASE_07',
        Parameters: [
          { ParameterName: UNMEASURED_DATE_PARAMETER.EX_BASE_07, ParameterValue: '31/08/2026' },
          { ParameterName: 'PararthmaAa', ParameterValue: '0' },
        ],
      },
    ]);
  });

  it('models the night-shift flag: an exit after midnight is marked, not dropped', async () => {
    const { client } = await start();
    const [row] = await readStamps(client, '2026-08-28');
    expect(row?.HourTo).toBe('00:30');
    expect(row?.IsEndDateDifferentThanDate).toBe(true);
  });

  it('reads EX_BASE_08 in the measured shape — a leave row with no hour fields is a row, not an error', async () => {
    const { client } = await start();
    const rows = await readSchedule(client, '2026-08-31');
    expect(rows).toHaveLength(3);
    // Missing hours and a missing or null Extra are read as '' — the record's «none».
    expect(rows).toContainEqual({
      aa: '0',
      Afm: '999999999',
      Date: '31/08/2026',
      Type: 'ΑΔΠΠΜ',
      HourFrom: '',
      HourTo: '',
      BreakMinutes: '15',
      BreakInWork: '0',
      Extra: '',
    });
    expect(rows.find((r) => r.Type === 'ΕΡΓ')).toMatchObject({ HourFrom: '08:00:00', HourTo: '16:00:00', Extra: '' });
  });

  it('a day with no stamps — measured 2026-09-28 as a bare null — is zero rows', async () => {
    const { client } = await start();
    await expect(readStamps(client, '2026-07-15')).resolves.toEqual([]);
  });

  it('learns the Date parameter and finds the rows when both placeholders move — nothing is hard-coded', async () => {
    const { client } = await start({
      dateParameter: { EX_BASE_07: 'Moved07', EX_BASE_08: 'Moved08' },
      rowsKey: { EX_BASE_07: 'Rows07', EX_BASE_08: 'Rows08' },
    });
    await expect(readStamps(client, '2026-08-28')).resolves.toHaveLength(1);
    await expect(readSchedule(client, '2026-08-28')).resolves.toHaveLength(3);
  });

  it('asks ServicesList once per client, and never goes near a filing route', async () => {
    const { client } = await start();
    await readStamps(client, '2026-08-28');
    await readStamps(client, '2026-08-31');
    await readSchedule(client, '2026-08-31');
    expect(fake?.requests.map((r) => r.route)).toEqual([
      'Authentication',
      'WebServices/ServicesList',
      'WebServices/ExecuteService',
      'WebServices/ExecuteService',
      'WebServices/ExecuteService',
    ]);
  });

  it('sends the branch from config, converted once: f_aa "007" goes as PararthmaAa "7"', async () => {
    const started = await startErganiFake();
    fake = started;
    const client = new ErganiClient(fakeClientConfig(started, { branchCode: '007' }), { now: () => MEASURED_NOW });
    await readStamps(client, '2026-08-31');
    expect(executed()[0]).toMatchObject({ Parameters: [{}, { ParameterName: 'PararthmaAa', ParameterValue: '7' }] });
  });

  it('refuses an out-of-window date LOCALLY: no request of any kind is made', async () => {
    const { fake, client } = await start();
    for (const date of ['2026-09-24', '2026-09-01', '2026-10-01']) {
      const err = await refusal(readStamps(client, date));
      expect(err, date).toBeInstanceOf(OutOfWindowError);
      expect((err as Error).message, date).toContain('Περιορισμός σε ημ/νιες προηγούμενου μήνα και πίσω');
      expect((err as Error).message, date).toContain('31/08/2026');
      await expect(readSchedule(client, date), date).rejects.toBeInstanceOf(OutOfWindowError);
    }
    expect(fake.requests).toEqual([]);
  });

  it('judges the month on the Athens calendar: 00:30 on 1 October in Athens is still 30 September in UTC', async () => {
    // Client and fake share the clock. At 20:30Z it is 23:30 on the 30th in Athens: September is this month.
    const before = await start({ now: () => Date.parse('2026-09-30T20:30:00Z') });
    await expect(readStamps(before.client, '2026-09-30')).rejects.toBeInstanceOf(OutOfWindowError);
    expect(before.fake.requests).toEqual([]);
    await before.fake.close();

    // At 21:30Z it is 00:30 on 1 October in Athens — while UTC still says 30 September. Readable.
    const after = await start({ now: () => Date.parse('2026-09-30T21:30:00Z') });
    await expect(readStamps(after.client, '2026-09-30')).resolves.toEqual([]);
    expect(executed()).toHaveLength(1);
  });

  it('still surfaces the ministry’s documented 400 if a date ever gets through — verbatim, once, never as zero rows', async () => {
    // Our clock says 1 October; the ministry's says 24 September. The local check passes; ΕΡΓΑΝΗ refuses.
    const { client } = await start({}, () => Date.parse('2026-10-01T00:30:00+03:00'));
    const err = await refusal(readStamps(client, '2026-09-15'));
    expect(err).toBeInstanceOf(ErganiError);
    expect(err).not.toBeInstanceOf(OutOfWindowError);
    expect((err as ErganiError).status).toBe(400);
    expect((err as ErganiError).ministryMessage).toBe(OUT_OF_WINDOW_MESSAGE);
    expect(executed()).toHaveLength(1);
  });

  it('refuses a service the signed-in user is not entitled to, before calling it', async () => {
    const { client } = await start({ entitlement: MEASURED_ENTITLEMENT.filter((s) => s !== 'EX_BASE_08') });
    const err = await refusal(readSchedule(client, '2026-08-31'));
    expect(err).toBeInstanceOf(ServiceDeclarationError);
    expect((err as Error).message).toContain('not in ServicesList');
    expect(executed()).toEqual([]);
  });
});

/** A client that answers from a script — for the shapes the fake never produces. */
function stub(answer: unknown | ((code: string) => unknown), catalogue?: unknown) {
  const calls: unknown[] = [];
  const declared = (type: unknown = 'Date') => [
    { name: 'Dt', description: '', isRequired: true, type, maxLength: 0 },
    { name: 'PararthmaAa', description: '', isRequired: true, type: 'Int', maxLength: 0 },
  ];
  const client: ReadClient = {
    listServices: async () =>
      catalogue ?? [
        { name: 'EX_BASE_07', description: '', parameters: declared() },
        { name: 'EX_BASE_08', description: '', parameters: declared(2) },
      ],
    executeService: async (code, params) => {
      calls.push({ code, params });
      return typeof answer === 'function' ? answer(code) : answer;
    },
    now: () => MEASURED_NOW,
    branchCode: '0',
  };
  return { client, calls };
}

const stamp = { Afm: '000000000', Date: '31/08/2026', HourFrom: '08:00', HourTo: '16:00', IsEndDateDifferentThanDate: '0' };

describe('the answer: recognised, or an error — never an empty month by accident', () => {
  it('recognises an empty answer: the service key present, holding no rows', async () => {
    for (const answer of [{ EX_BASE_07: { AnyName: [] } }, { EX_BASE_07: {} }]) {
      await expect(readStamps(stub(answer).client, '2026-08-31'), JSON.stringify(answer)).resolves.toEqual([]);
    }
  });

  it('finds the rows under whatever the one key is called, and reads a lone bare object as one row', async () => {
    await expect(readStamps(stub({ EX_BASE_07: { Whatever: [stamp, stamp] } }).client, '2026-08-31')).resolves.toHaveLength(2);
    await expect(readStamps(stub({ EX_BASE_07: { Whatever: stamp } }).client, '2026-08-31')).resolves.toEqual([
      { ...stamp, IsEndDateDifferentThanDate: false },
    ]);
  });

  it('reads a bare null as no stamps — for EX_BASE_07 only, the one service measured to answer so (2026-09-28)', async () => {
    await expect(readStamps(stub(null).client, '2026-08-31')).resolves.toEqual([]);
    const err = await refusal(readSchedule(stub(null).client, '2026-08-31'));
    expect(err).toBeInstanceOf(UnrecognisedAnswerError);
    expect((err as Error).message).toContain('it is null');
  });

  it('refuses an EMPTY answer from EX_BASE_07 — never observed, and not the measured `null`', async () => {
    // The client hands an empty body over as `undefined` (client.test.ts): it must not become «no stamps».
    const err = await refusal(readStamps(stub(undefined).client, '2026-08-31'));
    expect(err).toBeInstanceOf(UnrecognisedAnswerError);
    expect((err as Error).message).toContain('it is nothing');
  });

  it('refuses every answer it cannot recognise', async () => {
    const unrecognisable: unknown[] = [
      [],
      'EX_BASE_07',
      {},
      { EX_BASE_08: { Rows: [stamp] } },
      { EX_BASE_07: { Rows: [stamp] }, message: 'extra' },
      { EX_BASE_07: null },
      { EX_BASE_07: [] },
      { EX_BASE_07: '' },
      { EX_BASE_07: { Rows: null } },
      { EX_BASE_07: { Rows: '' } },
      { EX_BASE_07: { Rows: {} } },
      { EX_BASE_07: { Rows: [stamp], More: [stamp] } },
      { EX_BASE_07: { Rows: { Row: [stamp] } } },
    ];
    for (const answer of unrecognisable) {
      const err = await refusal(readStamps(stub(answer).client, '2026-08-31'));
      expect(err, JSON.stringify(answer)).toBeInstanceOf(UnrecognisedAnswerError);
    }
  });

  it('refuses the whole answer when any one row is not a row it knows — never a partial day', async () => {
    const { Afm: _afm, ...noAfm } = stamp;
    const bad: Array<Record<string, unknown>> = [
      noAfm,
      { ...stamp, HourTo2: '19:00' }, // an unknown field — perhaps a second interval (M1)
      { ...stamp, Afm: 12345678 }, // a number: the leading zero is already gone
      { ...stamp, Afm: '12345678' },
      { ...stamp, IsEndDateDifferentThanDate: '2' },
      { ...stamp, IsEndDateDifferentThanDate: true },
      { ...stamp, HourFrom: null },
      { ...stamp, Date: '' },
    ];
    for (const row of bad) {
      const err = await refusal(readStamps(stub({ EX_BASE_07: { Rows: [stamp, row] } }).client, '2026-08-31'));
      expect(err, JSON.stringify(row)).toBeInstanceOf(UnrecognisedAnswerError);
      expect((err as Error).message).toContain('row 1');
    }
  });

  it('refuses the whole answer when a row names another day, or names its day in a form it does not know', async () => {
    // What the Date parameter MEANS is unmeasured: read as «from», every day would answer the same
    // stamps, and a record that can never delete would hold each one under every day.
    for (const date of ['30/08/2026', '01/09/2026', '2026-08-30', '31/8/2026', '31-08-2026', '2026-08-31T09:00:00', '2026-08-31T00:00:00Z']) {
      const err = await refusal(readStamps(stub({ EX_BASE_07: { Rows: [stamp, { ...stamp, Date: date }] } }).client, '2026-08-31'));
      expect(err, date).toBeInstanceOf(UnrecognisedAnswerError);
      expect((err as Error).message).toContain('row 1');
      expect((err as Error).message).not.toContain(date);
    }
    for (const date of ['31/08/2026', '2026-08-31', '2026-08-31T00:00:00']) {
      await expect(readStamps(stub({ EX_BASE_07: { Rows: [{ ...stamp, Date: date }] } }).client, '2026-08-31'), date).resolves.toHaveLength(1);
    }
  });

  it('holds an EX_BASE_08 row to the same standard: an unknown or missing field refuses the answer', async () => {
    // The three row shapes measured 2026-09-28: work («ΕΡΓ», hours, Extra null), rest («ΑΝ», no hours, Extra
    // null), leave (no hours, no Extra — here with the guide's §4 example code).
    const work = { aa: '0', Afm: '000000000', Date: '31/08/2026', Type: 'ΕΡΓ', HourFrom: '09:00:00', HourTo: '17:00:00', Extra: null, BreakMinutes: '15', BreakInWork: '0' };
    const rest = { aa: '0', Afm: '000000000', Date: '31/08/2026', Type: 'ΑΝ', Extra: null, BreakMinutes: '15', BreakInWork: '0' };
    const leave = { aa: '0', Afm: '999999999', Date: '31/08/2026', Type: 'ΑΔΠΠΜ', BreakMinutes: '15', BreakInWork: '0' };
    await expect(readSchedule(stub({ EX_BASE_08: { Working: [work, rest, leave] } }).client, '2026-08-31')).resolves.toEqual([
      { ...work, Extra: '' },
      { ...rest, HourFrom: '', HourTo: '', Extra: '' },
      { ...leave, HourFrom: '', HourTo: '', Extra: '' },
    ]);
    const { Type: _type, ...noType } = leave;
    const { aa: _aa, ...noBranch } = leave;
    const { Date: _date, ...noDate } = leave;
    const { HourTo: _to, ...onlyFrom } = work;
    for (const row of [noType, noBranch, noDate, onlyFrom, { ...leave, HourFrom2: '17:00' }, { ...leave, Type: '' }, { ...work, Extra: 7 }]) {
      const err = await refusal(readSchedule(stub({ EX_BASE_08: { Rows: [leave, row] } }).client, '2026-08-31'));
      expect(err, JSON.stringify(row)).toBeInstanceOf(UnrecognisedAnswerError);
    }
  });

  it('refuses a schedule answer holding a row for another day or another branch — as it does for stamps', async () => {
    const leave = { aa: '0', Afm: '999999999', Date: '31/08/2026', Type: 'ΑΔΠΠΜ', BreakMinutes: '15', BreakInWork: '0' };
    for (const row of [{ ...leave, Date: '30/08/2026' }, { ...leave, Date: '31/8/2026' }, { ...leave, aa: '1' }]) {
      const err = await refusal(readSchedule(stub({ EX_BASE_08: { Working: [leave, row] } }).client, '2026-08-31'));
      expect(err, JSON.stringify(row)).toBeInstanceOf(UnrecognisedAnswerError);
      expect((err as Error).message).toContain('row 1');
    }
    await expect(readSchedule(stub({ EX_BASE_08: { Working: [{ ...leave, aa: '00' }] } }).client, '2026-08-31')).resolves.toHaveLength(1);
  });

  it('holds a stamp row that names its branch — as aa (measured on 08) or Aa (the services text) — to the branch asked', async () => {
    for (const named of [{ aa: '0' }, { Aa: '0' }, {}]) {
      await expect(readStamps(stub({ EX_BASE_07: { Rows: [{ ...stamp, ...named }] } }).client, '2026-08-31'), JSON.stringify(named)).resolves.toHaveLength(1);
    }
    for (const named of [{ aa: '1' }, { Aa: '3' }, { aa: '0', Aa: '1' }]) {
      const err = await refusal(readStamps(stub({ EX_BASE_07: { Rows: [stamp, { ...stamp, ...named }] } }).client, '2026-08-31'));
      expect(err, JSON.stringify(named)).toBeInstanceOf(UnrecognisedAnswerError);
      expect((err as Error).message).toContain('names a branch');
    }
  });

  it('names the shape, never a value — a value is a person’s ΑΦΜ or hours', async () => {
    const err = await refusal(
      readStamps(stub({ EX_BASE_07: { Rows: [{ ...stamp, Afm: '12345678', HourTo2: '19:45' }] } }).client, '2026-08-31'),
    );
    expect((err as Error).message).toContain('HourTo2');
    expect((err as Error).message).not.toContain('12345678');
    expect((err as Error).message).not.toContain('19:45');
  });
});

describe('the Date parameter: read from ServicesList, never guessed', () => {
  it('takes the declared name, with the type written as a word or as the guide’s number (Date = 2)', async () => {
    const s = stub((code: string) => ({ [code]: {} }));
    await readStamps(s.client, '2026-08-31');
    await readSchedule(s.client, '2026-08-31');
    expect(s.calls).toEqual([
      {
        code: 'EX_BASE_07',
        params: { Parameters: [{ ParameterName: 'Dt', ParameterValue: '31/08/2026' }, { ParameterName: 'PararthmaAa', ParameterValue: '0' }] },
      },
      {
        code: 'EX_BASE_08',
        params: { Parameters: [{ ParameterName: 'Dt', ParameterValue: '31/08/2026' }, { ParameterName: 'PararthmaAa', ParameterValue: '0' }] },
      },
    ]);
  });

  it('refuses any other declaration, naming what it found, and calls nothing', async () => {
    const p = (name: string, type: unknown) => ({ name, description: '', isRequired: true, type, maxLength: 0 });
    const catalogues: Array<[unknown, string]> = [
      [{ EX_BASE_07: [] }, 'not a list of services'],
      [[{ name: 'EX_BASE_08', parameters: [p('Dt', 'Date'), p('PararthmaAa', 'Int')] }], 'not in ServicesList'],
      [[{ name: 'EX_BASE_07' }], 'unrecognised form'],
      [[{ name: 'EX_BASE_07', parameters: [p('Dt', 'Date')] }], 'declares [Dt (type "Date")]'],
      [[{ name: 'EX_BASE_07', parameters: [p('PararthmaAa', 'Int')] }], 'declares [PararthmaAa (type "Int")]'],
      [[{ name: 'EX_BASE_07', parameters: [p('Dt', 'Text'), p('PararthmaAa', 'Int')] }], 'Dt (type "Text")'],
      [[{ name: 'EX_BASE_07', parameters: [p('Dt', 3), p('PararthmaAa', 'Int')] }], 'Dt (type 3)'],
      [[{ name: 'EX_BASE_07', parameters: [p('Dt', '2'), p('PararthmaAa', 'Int')] }], 'Dt (type "2")'],
      [[{ name: 'EX_BASE_07', parameters: [p('From', 'Date'), p('To', 'Date'), p('PararthmaAa', 'Int')] }], 'From (type "Date"), To (type "Date")'],
      [[{ name: 'EX_BASE_07', parameters: [p('Dt', 'Date'), p('PararthmaAa', 'Int'), p('Afm', 'Text')] }], 'Afm (type "Text")'],
    ];
    for (const [catalogue, named] of catalogues) {
      const s = stub({ EX_BASE_07: {} }, catalogue);
      const err = await refusal(readStamps(s.client, '2026-08-31'));
      expect(err, named).toBeInstanceOf(ServiceDeclarationError);
      expect((err as Error).message, named).toContain(named);
      expect(s.calls, named).toEqual([]);
    }
  });

  it('asks ServicesList again after a failed fetch, rather than remembering the failure', async () => {
    let asked = 0;
    const s = stub({ EX_BASE_07: {} });
    const client: ReadClient = {
      ...s.client,
      listServices: async () => {
        asked += 1;
        if (asked === 1) throw new Error('network down');
        return s.client.listServices();
      },
    };
    await expect(readStamps(client, '2026-08-31')).rejects.toThrow('network down');
    await expect(readStamps(client, '2026-08-31')).resolves.toEqual([]);
    expect(asked).toBe(2);
  });
});

describe('the one-month window', () => {
  it('accepts the previous month and earlier', () => {
    for (const date of ['2026-08-31', '2026-08-01', '2026-07-15', '2025-12-31']) {
      expect(() => assertReadableDate(date, '2026-09-24'), date).not.toThrow();
    }
    expect(() => assertReadableDate('2026-12-31', '2027-01-01')).not.toThrow();
  });

  it('refuses this month and later, naming the limit and the latest readable date — never moving the date', () => {
    for (const [date, today, latest] of [
      ['2026-09-24', '2026-09-24', '2026-08-31'],
      ['2026-09-01', '2026-09-24', '2026-08-31'],
      ['2026-10-01', '2026-09-24', '2026-08-31'],
      ['2027-01-01', '2027-01-01', '2026-12-31'],
      ['2027-01-15', '2026-09-24', '2026-08-31'],
      ['2024-03-01', '2024-03-31', '2024-02-29'],
    ] as const) {
      let err: unknown;
      try {
        assertReadableDate(date, today);
      } catch (e) {
        err = e;
      }
      expect(err, date).toBeInstanceOf(OutOfWindowError);
      const { date: asked, latestReadable, message } = err as OutOfWindowError;
      expect(asked, date).toBe(date);
      expect(latestReadable, date).toBe(latest);
      expect(message, date).toContain('previous month or earlier');
      expect(message, date).toContain('Περιορισμός σε ημ/νιες προηγούμενου μήνα και πίσω');
    }
  });

  it('refuses a date that is not a YYYY-MM-DD calendar date, before anything else', () => {
    for (const date of ['31/08/2026', '2026-8-31', '2026-02-30', '2026-13-01', '']) {
      expect(() => assertReadableDate(date, '2026-09-24'), date).toThrow(RangeError);
    }
  });

  it('reads "today" on the Athens calendar, not UTC’s', () => {
    expect(athensDate(Date.parse('2026-09-30T20:30:00Z'))).toBe('2026-09-30');
    expect(athensDate(Date.parse('2026-09-30T21:30:00Z'))).toBe('2026-10-01');
    // Winter time: Athens is UTC+2 after the last Sunday of October.
    expect(athensDate(Date.parse('2026-11-30T21:59:00Z'))).toBe('2026-11-30');
    expect(athensDate(Date.parse('2026-11-30T22:00:00Z'))).toBe('2026-12-01');
  });
});

describe('PararthmaAa — the one conversion from f_aa', () => {
  it('writes the branch as the integer, in decimal digits', () => {
    expect(pararthmaAaOf('0')).toBe('0');
    expect(pararthmaAaOf('00')).toBe('0');
    expect(pararthmaAaOf('12')).toBe('12');
    expect(pararthmaAaOf('00012')).toBe('12');
  });

  it('refuses anything that is not an f_aa', () => {
    for (const code of ['', '-1', '1.5', 'A', '123456', ' 1']) {
      expect(() => pararthmaAaOf(code), code).toThrow();
    }
  });
});
