// SPDX-License-Identifier: EUPL-1.2
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '../src/config.js';
import type { ReadClient } from '../src/ergani/exbase.js';
import { heartbeatSender } from '../src/heartbeat.js';
import { dueAtStart, markArchiveRun, noStandingScheduleOf } from '../src/records/cli.js';
import { REREAD_DAYS, monthsBefore, nextRunAfter, runDailyArchive, type DailyOptions } from '../src/records/daily.js';
import { readArchiveStatus, recordArchiveStatus } from '../src/records/status.js';
import { archiveOverview } from '../src/desktop/owner/archive.js';
import { RealmMismatchError } from '../src/records/pull.js';
import { EmployerMismatchError, openRecordStore, pullLog } from '../src/records/store.js';
import { athensInstant } from '../src/stamp/athens.js';

/**
 * THE DAILY ARCHIVE RUN (src/records/daily.ts) — which months it reads, for which branches, and what the monitor hears.
 * Against stub read clients (a fabricated person, two services, every day) and a real record store in a scratch
 * folder. ⛔ Nothing reaches a network: the clients are stubs, and the heartbeat is recorded, never sent.
 */

const EMPLOYER = '000000001';
const PERSON = '000000002';
const OTHER_EMPLOYER = '000000003';
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * What a stub answers. `noScheduleDeclared`: EX_BASE_08 answers a bare `null`, as ΕΡΓΑΝΗ does for a branch on which no
 * schedule was ever declared (measured).
 */
interface Behaviour {
  noStampsIn?: string;
  failIn?: string;
  noScheduleDeclared?: boolean;
}

/** A read client for `branch`: on every day a stamp and a declared working day — or no stamp, or a failure. */
function stub(
  branch: string,
  clock: () => number,
  behave: Behaviour = {},
): ReadClient {
  const declared = [
    { name: 'Date', type: 'Date' },
    { name: 'PararthmaAa', type: 'Int' },
  ];
  return {
    listServices: async () => [
      { name: 'EX_BASE_07', description: '', parameters: declared },
      { name: 'EX_BASE_08', description: '', parameters: declared },
    ],
    executeService: async (code, params) => {
      const date = (params as { Parameters: Array<{ ParameterValue: string }> }).Parameters[0]?.ParameterValue ?? '';
      const month = `${date.slice(6, 10)}-${date.slice(3, 5)}`;
      if (month === behave.failIn) throw new Error('ΕΡΓΑΝΗ did not answer (stub)');
      if (code === 'EX_BASE_07') {
        if (month === behave.noStampsIn) return null;
        return { EX_BASE_07: { Rows: [{ Afm: PERSON, Date: date, HourFrom: '09:00', HourTo: '17:00', IsEndDateDifferentThanDate: '0' }] } };
      }
      if (behave.noScheduleDeclared === true) return null;
      return {
        EX_BASE_08: {
          Working: [
            { aa: branch, Afm: PERSON, Date: date, Type: 'ΕΡΓ', HourFrom: '09:00:00', HourTo: '17:00:00', BreakMinutes: '15', BreakInWork: '0', Extra: null },
          ],
        },
      };
    },
    now: clock,
    branchCode: branch,
  };
}

function install(branches: readonly string[] = ['0'], behave: Behaviour = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ergani-daily-'));
  dirs.push(dir);
  const store = join(dir, 'records.sqlite');
  openRecordStore(store).close();
  let clock = athensInstant('2026-10-21', '03:15');
  const beats: Array<{ status: string; message: string }> = [];
  const log: string[] = [];
  const options = (extra: Partial<DailyOptions> = {}): DailyOptions => ({
    openStore: () => {
      if (!existsSync(store)) throw new Error('no record');
      return openRecordStore(store);
    },
    clients: branches.map((b) => stub(b, () => clock, behave)),
    realm: 'local',
    employerAfm: EMPLOYER,
    archiveFrom: '2026-05',
    exportsDir: join(dir, 'exports'),
    now: () => clock,
    beat: async (status, message) => void beats.push({ status, message }),
    log: (line) => void log.push(line),
    ...extra,
  });
  const pulls = () => {
    const db = openRecordStore(store);
    try {
      return pullLog(db).map((p) => `${p.month}/${p.branch}`);
    } finally {
      db.close();
    }
  };
  return {
    dir,
    store,
    beats,
    log,
    options,
    pulls,
    at: (day: string, time = '03:15') => {
      clock = athensInstant(day, time);
    },
  };
}

describe('the daily archive run', () => {
  it('persists the last good archive and every incomplete month/branch, preserving success when a later read fails', async () => {
    const t = install(['0', '1']);
    const options = () => t.options({ status: (outcome) => recordArchiveStatus(t.store, outcome, t.options().now()) });
    await runDailyArchive(options());
    const good = readArchiveStatus(t.store)!;
    expect(good).toMatchObject({ kind: 'up', incomplete: [], lastGood: new Date(t.options().now()).toISOString() });
    t.at('2026-10-29');
    const failed = { ...options(), clients: [stub('0', t.options().now), stub('1', t.options().now, { failIn: '2026-09' })] };
    await runDailyArchive(failed);
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'failed', lastGood: good.lastGood, incomplete: [{ month: '2026-09', branch: '1' }] });
    await runDailyArchive(options());
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'up', incomplete: [], lastGood: new Date(t.options().now()).toISOString() });
  });

  it('keeps a failed page and a no-stamps warning visible, without treating either as a good archive', async () => {
    const t = install(['0'], { noStampsIn: '2026-09' });
    const status = (outcome: Parameters<typeof recordArchiveStatus>[1]) => recordArchiveStatus(t.store, outcome, t.options().now());
    await runDailyArchive(t.options({ status }));
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'down', incomplete: [{ month: '2026-09', branch: '0' }] });
    expect(readArchiveStatus(t.store)?.lastGood).toBeUndefined();
    await runDailyArchive(t.options({ status, exportsDir: join(fileURLToPath(new URL('../', import.meta.url)), 'must-not-write') }));
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'failed', pages: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'] });
  });

  it('keeps never-read months visible after they leave the readable window, and shows a runtime failure when status cannot be saved', async () => {
    const t = install(['0', '1']);
    recordArchiveStatus(t.store, { kind: 'up' }, t.options().now());
    const overview = String(archiveOverview(t.store, '2026-04', ['0', '1'], t.options().now(), true));
    expect(overview).toContain('2026-04 — παράρτημα 0');
    expect(overview).toContain('2026-04 — παράρτημα 1');
    expect(overview).toContain('Ο τελευταίος έλεγχος του μηνιαίου αρχείου απέτυχε');
    expect(overview).toContain('Τελευταίο πλήρες μηνιαίο αρχείο');
  });

  it('an archive that cannot even start retains the previously incomplete months and pages until a successful run', async () => {
    const t = install();
    recordArchiveStatus(t.store, { kind: 'failed', incomplete: [{ month: '2026-09', branch: '0' }], pages: ['2026-09'] }, t.options().now());
    const status = (outcome: Parameters<typeof recordArchiveStatus>[1]) => recordArchiveStatus(t.store, outcome, t.options().now());
    await expect(runDailyArchive(t.options({ archiveFrom: '', status }))).rejects.toThrow(/ARCHIVE_FROM/);
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'failed', incomplete: [{ month: '2026-09', branch: '0' }], pages: ['2026-09'] });
    await runDailyArchive(t.options({ status }));
    expect(readArchiveStatus(t.store)).toMatchObject({ kind: 'up', incomplete: [], pages: [] });
  });

  it('reads every month from ARCHIVE_FROM up to last month, five at most, for every branch — then tells the monitor «up»', async () => {
    const t = install(['0', '1']);
    expect(await runDailyArchive(t.options())).toMatchObject({ kind: 'up', message: '2026-09 held — 60 stamp rows; 5 month(s) held' });
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    expect(t.pulls()).toEqual(months.flatMap((m) => [`${m}/0`, `${m}/1`]));
    expect(readdirSync(join(t.dir, 'exports')).sort()).toEqual(months.map((m) => `sygkrisi-${m}.html`));
    expect(t.beats).toEqual([{ status: 'up', message: '2026-09 held — 60 stamp rows; 5 month(s) held' }]);
  });

  it('reads a held month again once its last complete pull is a week old — and writes every page again', async () => {
    const t = install();
    await runDailyArchive(t.options());
    const first = t.pulls().length;
    t.at('2026-10-22');
    await runDailyArchive(t.options());
    expect(t.pulls()).toHaveLength(first);
    t.at('2026-10-28', '03:16');
    await runDailyArchive(t.options());
    // A week on: months one to FOUR back are read again; FIVE back is not — it was held complete once.
    expect(t.pulls().slice(first)).toEqual(['2026-06/0', '2026-07/0', '2026-08/0', '2026-09/0']);
    expect(t.beats.map((b) => b.status)).toEqual(['up', 'up', 'up']);
    expect(REREAD_DAYS).toBe(7);
  });

  it('still catches up a month five back that was never held complete', async () => {
    const t = install(['0'], { failIn: '2026-05' });
    expect((await runDailyArchive(t.options())).kind).toBe('failed');
    t.at('2026-10-22');
    const fixed = install(['0']);
    // The same record, now that ΕΡΓΑΝΗ answers May: May is pulled again, though it is five back.
    const again = await runDailyArchive({ ...fixed.options(), openStore: t.options().openStore });
    expect(again.kind).toBe('up');
    expect(t.pulls().filter((p) => p.startsWith('2026-05'))).toHaveLength(2);
  });

  it('a month still failing: no «up» — the monitor hears nothing, and the month is asked again the next day', async () => {
    const t = install(['0'], { failIn: '2026-09' });
    expect(await runDailyArchive(t.options())).toMatchObject({ kind: 'failed', message: expect.stringContaining('2026-09 (branch 0)') });
    expect(t.beats).toEqual([]);
    t.at('2026-10-22');
    await runDailyArchive(t.options());
    expect(t.pulls().filter((p) => p === '2026-09/0')).toHaveLength(2);
    expect(t.beats).toEqual([]);
  });

  it('tells the monitor «down» when last month\'s latest answer for a branch holds no stamp while its schedule declares hours', async () => {
    const t = install(['0'], { noStampsIn: '2026-09' });
    expect(await runDailyArchive(t.options())).toMatchObject({ kind: 'down', message: expect.stringContaining('NO stamp for branch 0') });
    expect(t.beats.map((b) => b.status)).toEqual(['down']);
  });

  it('with no record, fails before reading anything or telling the monitor anything — it never starts a new one', async () => {
    const t = install();
    rmSync(t.store);
    const read: string[] = [];
    const watched: ReadClient = { ...stub('0', Date.now), executeService: async () => void read.push('x') };
    await expect(runDailyArchive(t.options({ clients: [watched] }))).rejects.toThrow(/no record/);
    expect(read).toEqual([]);
    expect(t.beats).toEqual([]);
    expect(existsSync(t.store)).toBe(false);
  });

  it('says «up, waiting» while ARCHIVE_FROM is still ahead, and refuses an ARCHIVE_FROM that is not YYYY-MM', async () => {
    const t = install();
    expect(await runDailyArchive(t.options({ archiveFrom: '2026-10' }))).toMatchObject({ kind: 'up', message: 'waiting — the archive starts with 2026-10' });
    expect(t.pulls()).toEqual([]);
    await expect(runDailyArchive(t.options({ archiveFrom: '' }))).rejects.toThrow(/ARCHIVE_FROM/);
  });

  it('⛔ never writes a page inside a code folder — the run fails instead, and the monitor hears nothing', async () => {
    const t = install();
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const outcome = await runDailyArchive(t.options({ exportsDir: join(repo, 'exports-must-not-exist') }));
    expect(outcome).toMatchObject({ kind: 'failed', message: expect.stringContaining('its page') });
    expect(existsSync(join(repo, 'exports-must-not-exist'))).toBe(false);
    expect(t.beats).toEqual([]);
  });

  it('⛔ refuses another employer\'s or another realm\'s record even when every month is held — no page, no «up»', async () => {
    const t = install();
    expect((await runDailyArchive(t.options())).kind).toBe('up');
    // The next hour: every month is held recently, so nothing would be pulled — the record is still checked first.
    t.at('2026-10-21', '04:15');
    rmSync(join(t.dir, 'exports'), { recursive: true });
    await expect(runDailyArchive(t.options({ employerAfm: OTHER_EMPLOYER }))).rejects.toThrow(EmployerMismatchError);
    await expect(runDailyArchive(t.options({ realm: 'trial' }))).rejects.toThrow(RealmMismatchError);
    expect(existsSync(join(t.dir, 'exports'))).toBe(false);
    expect(t.beats.map((b) => b.status)).toEqual(['up']);
  });

  it('a branch that declares no standing schedule (SCHEDULE=none): its EX_BASE_08 `null` is a day with none — and only there', async () => {
    const declared = install(['0'], { noScheduleDeclared: true });
    // Not said: the `null` is an answer the reader does not know, and every month stays incomplete.
    expect((await runDailyArchive(declared.options())).kind).toBe('failed');
    expect(declared.beats).toEqual([]);
    const none = install(['0', '1'], { noScheduleDeclared: true });
    expect((await runDailyArchive(none.options({ noStandingSchedule: new Set(['0', '1']) }))).kind).toBe('up');
    // Said for branch 1 only: branch 0's `null` is still refused.
    const one = install(['0', '1'], { noScheduleDeclared: true });
    expect(await runDailyArchive(one.options({ noStandingSchedule: new Set(['1']) }))).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('branch 0'),
    });
    expect(one.log.join('\n')).not.toMatch(/branch 1:/);
  });

  it('reads which branches declare no standing schedule from the same settings as the page', () => {
    const env = { ERGANI_BRANCHES: '0,1,2', STAMP_BRANCH_0_LABEL: 'Κέντρο', STAMP_BRANCH_1_LABEL: 'Λιμάνι', STAMP_BRANCH_2_LABEL: 'Χώρα' };
    expect([...noStandingScheduleOf(env)]).toEqual([]);
    expect([...noStandingScheduleOf({ ...env, STAMP_BRANCH_1_SCHEDULE: 'none', STAMP_BRANCH_2_SCHEDULE: 'ergani' })]).toEqual(['1']);
    expect(() => noStandingScheduleOf({ ...env, STAMP_BRANCH_1_SCHEDULE: 'NONE' })).toThrow(/STAMP_BRANCH_1_SCHEDULE/);
  });

  it('at start, runs only when the last run was missed — none began in the last day, whatever it read', async () => {
    const t = install();
    expect(dueAtStart(t.store, athensInstant('2026-10-21', '03:00'))).toBe(true);
    markArchiveRun(t.store, athensInstant('2026-10-21', '03:15'));
    // A restart in clinic hours the same day: not due — the reads would share the branch logins with the outbox.
    expect(dueAtStart(t.store, athensInstant('2026-10-21', '11:00'))).toBe(false);
    expect(dueAtStart(t.store, athensInstant('2026-10-22', '03:15') - 1)).toBe(false);
    expect(dueAtStart(t.store, athensInstant('2026-10-22', '03:15'))).toBe(true);
    // A run that found every month held read nothing and left no pull — it still counts as the day's run.
    await runDailyArchive(t.options());
    t.at('2026-10-22');
    markArchiveRun(t.store, athensInstant('2026-10-22', '03:15'));
    const before = t.pulls().length;
    await runDailyArchive(t.options());
    expect(t.pulls()).toHaveLength(before);
    expect(dueAtStart(t.store, athensInstant('2026-10-22', '11:00'))).toBe(false);
    // A note that cannot be read: due, so the run itself says what is wrong.
    writeFileSync(`${t.store}.last-run`, 'not a time\n');
    expect(dueAtStart(t.store, athensInstant('2026-10-22', '11:00'))).toBe(true);
  });

  it('months count back across a year end', () => {
    expect(monthsBefore('2026-02', 3)).toBe('2025-11');
    expect(monthsBefore('2026-01', 1)).toBe('2025-12');
  });
});

describe('when the daily run comes round', () => {
  it('the next 03:15 Athens after now — the same day before it, the next day after it, across the clock change', () => {
    expect(nextRunAfter(athensInstant('2026-10-21', '02:00'), '03:15', athensInstant)).toBe(athensInstant('2026-10-21', '03:15'));
    expect(nextRunAfter(athensInstant('2026-10-21', '03:15'), '03:15', athensInstant)).toBe(athensInstant('2026-10-22', '03:15'));
    // Summer time ends at 04:00 on 25 October 2026, and 03:15 happens twice that night: the run is the later one,
    // 03:15 winter time — once, on the 25th.
    const sunday = nextRunAfter(athensInstant('2026-10-24', '12:00'), '03:15', athensInstant);
    expect(new Date(sunday).toISOString()).toBe('2026-10-25T01:15:00.000Z');
    expect(nextRunAfter(sunday, '03:15', athensInstant)).toBe(athensInstant('2026-10-26', '03:15'));
  });
});

describe('the heartbeat', () => {
  it('calls the monitor\'s URL with the status and message — its own query replaced — and never says the URL in an error', async () => {
    const asked: string[] = [];
    const ok = heartbeatSender(new Secret('https://monitor.invalid/api/push/T0KEN?status=up&msg=OK&ping='), async (url) => {
      asked.push(String(url));
      return new Response('', { status: 200 });
    });
    await ok('down', 'September held with NO stamp');
    expect(asked).toEqual(['https://monitor.invalid/api/push/T0KEN?status=down&msg=September+held+with+NO+stamp&ping=']);
    const refused = heartbeatSender(new Secret('https://monitor.invalid/api/push/T0KEN'), async () => new Response('', { status: 404 }));
    await expect(refused('up', 'OK')).rejects.toThrow(/HTTP 404/);
    const dead = heartbeatSender(new Secret('https://monitor.invalid/api/push/T0KEN'), async () => {
      throw new TypeError('fetch failed: monitor.invalid T0KEN');
    });
    const error = await dead('up', 'OK').catch((e: unknown) => e as Error);
    expect(String(error)).not.toMatch(/T0KEN|monitor\.invalid/);
  });
});
