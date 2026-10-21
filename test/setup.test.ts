// SPDX-License-Identifier: EUPL-1.2
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadEmployerConfig } from '../src/config.js';
import { FOR_YOU, askSetup, nextSteps, terminalIo, type SetupIo } from '../src/setup/cli.js';
import { answerProblems, bindAddressProblem, settingsFile, type SetupAnswers } from '../src/setup/settings.js';
import { loadStampSettings } from '../src/stamp/config.js';
import { AFM } from './fixtures/people.js';

/**
 * THE GUIDED FIRST SETUP (src/setup/) — what it asks, what it refuses, and the file it writes: a file the services
 * read exactly as written. ⛔ Fabricated employer and logins; nothing is sent anywhere.
 */

const answers = (extra: Partial<SetupAnswers> = {}): SetupAnswers => ({
  instance: 'iatreio-test',
  label: 'Οδοντιατρείο Δοκιμής',
  employerAfm: AFM.employer,
  realm: 'trial',
  branches: [{ code: '0', label: '', inspectorateEmail: '', schedule: 'ergani', username: 'example01', password: 'Pass.word1' }],
  bindAddress: '192.168.1.20',
  port: 8880,
  cookieSecure: false,
  ntfyUrl: '',
  ntfyToken: '',
  stampHeartbeatUrl: '',
  archiveHeartbeatUrl: '',
  archiveFrom: '2026-09',
  ...extra,
});

/** The settings file, read the way Compose hands it to a container: KEY=value lines, comments and blanks skipped. */
function asEnvironment(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return { ...env, STAMP_DB: '/data/stamp/stamp.sqlite' };
}

describe('the settings file', () => {
  it('is read back by the services exactly as it was answered — one branch', () => {
    const env = asEnvironment(settingsFile(answers(), '2026-10-21T10:00:00Z'));
    const employer = loadEmployerConfig(env);
    expect(employer).toMatchObject({ employerAfm: AFM.employer, erganiRealm: 'trial' });
    expect(employer.branches.map((b) => [b.branchCode, b.erganiUsername, b.erganiPassword.expose(), b.erganiUsertype])).toEqual([
      ['0', 'example01', 'Pass.word1', '02'],
    ]);
    const stamp = loadStampSettings(env);
    expect(stamp).toMatchObject({ instance: 'iatreio-test', label: 'Οδοντιατρείο Δοκιμής', cookieSecure: false, ntfy: undefined });
    expect(stamp.branches).toEqual([{ code: '0', label: '', inspectorateEmail: undefined, scheduleFromErgani: true }]);
    expect(env['ERGANI_BIND_ADDRESS']).toBe('192.168.1.20');
    // The volumes are named after the employer: a second employer's folder never shares the first one's record.
    expect(env['COMPOSE_PROJECT_NAME']).toBe('ergani-iatreio-test');
    expect(env['ARCHIVE_FROM']).toBe('2026-09');
  });

  it('two branches, each with its own login, label, Επιθεώρηση and schedule; and the real register only when chosen', () => {
    const two = answers({
      realm: 'production',
      branches: [
        { code: '0', label: 'Κέντρο', inspectorateEmail: 'kentro@example.invalid', schedule: 'ergani', username: 'example01', password: 'Pass.word1' },
        { code: '1', label: 'Λιμάνι', inspectorateEmail: '', schedule: 'none', username: 'example02', password: 'Pass#word2' },
      ],
    });
    const env = asEnvironment(settingsFile(two, 'now'));
    expect(loadEmployerConfig(env)).toMatchObject({ erganiRealm: 'production' });
    expect(loadEmployerConfig(env).branches.map((b) => b.erganiPassword.expose())).toEqual(['Pass.word1', 'Pass#word2']);
    expect(loadStampSettings(env).branches).toEqual([
      { code: '0', label: 'Κέντρο', inspectorateEmail: 'kentro@example.invalid', scheduleFromErgani: true },
      { code: '1', label: 'Λιμάνι', inspectorateEmail: undefined, scheduleFromErgani: false },
    ]);
    expect(nextSteps(two).join('\n')).toContain('enroll --branch 1');
  });

  it('⛔ refuses a page address that is not private — the page is never on the internet', () => {
    // The overlay range (Tailscale's, 100.64/10) at its two ends and just past them — built from the numbers, so the
    // package holds no address that could be a real machine's on such a network.
    const overlay = (second: number) => [100, second, 0, 1].join('.');
    for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.20', overlay(64), overlay(127)]) {
      expect(bindAddressProblem(ok), ok).toBeUndefined();
    }
    for (const bad of ['0.0.0.0', '8.8.8.8', '172.32.0.1', overlay(63), overlay(128), '192.169.1.1', '256.1.1.1', 'localhost', '::1', '']) {
      expect(bindAddressProblem(bad), bad).toBeDefined();
    }
    expect(() => settingsFile(answers({ bindAddress: '0.0.0.0' }), 'now')).toThrow(/Διεύθυνση σελίδας/);
  });

  it('refuses what the file format would change, and what the services would refuse at start', () => {
    const problems = (extra: Partial<SetupAnswers>) => answerProblems(answers(extra));
    const branch = (b: Partial<SetupAnswers['branches'][number]>) => ({ branches: [{ ...answers().branches[0]!, ...b }] });
    expect(problems({})).toEqual([]);
    expect(problems(branch({ password: 'Pa$$word1' }))).toHaveLength(1);
    expect(problems(branch({ password: 'Pass word1' }))).toHaveLength(1);
    expect(problems(branch({ password: 'short' }))).toHaveLength(1);
    expect(problems(branch({ password: 'thirteen.char' }))).toHaveLength(1);
    expect(problems(branch({ username: 'short' }))).toHaveLength(1);
    expect(problems(branch({ code: '01' }))).toHaveLength(1);
    expect(problems({ label: 'Οδοντιατρείο "Δοκιμή"' })).toHaveLength(1);
    expect(problems({ label: 'Οδοντιατρείο #1' })).toHaveLength(1);
    // Only ` #` starts a comment: Compose keeps a leading `#` (ERGANI-USER.md offers `#` for the password).
    expect(problems(branch({ password: '#Pass.wd1' }))).toEqual([]);
    expect(problems(branch({ password: 'Pass #wd1' }))).toHaveLength(1);
    expect(problems(branch({ inspectorateEmail: 'kentro@example.invalid' }))).toEqual([]);
    expect(problems(branch({ inspectorateEmail: 'ke$ntro@example.invalid' }))).toEqual(['Παράρτημα 0, email Επιθεώρησης: χωρίς εισαγωγικά, $, \\ ή αλλαγή γραμμής']);
    expect(problems(branch({ inspectorateEmail: 'kentro' }))).toEqual(['Παράρτημα 0, email Επιθεώρησης: δεν μοιάζει με email']);
    expect(problems({ employerAfm: `${AFM.employer.slice(0, 8)}0` })).toHaveLength(1);
    expect(problems({ instance: 'Iatreio' })).toHaveLength(1);
    expect(problems({ ntfyUrl: 'https://ntfy.sh/topic', ntfyToken: 'tk_x' })).toHaveLength(1);
    expect(problems({ ntfyUrl: 'https://ntfy.example.invalid/topic' })).toHaveLength(1);
    expect(
      problems({
        branches: [
          { ...answers().branches[0]!, label: 'Κέντρο' },
          { ...answers().branches[0]!, code: '1', label: '' },
        ],
      }),
    ).toHaveLength(1);
  });
});

describe('the conversation', () => {
  /** A scripted terminal: answers in order, secrets from their own queue; nothing printed may hold a secret. */
  function scripted(replies: string[], secrets: string[]) {
    const printed: string[] = [];
    const io: SetupIo = {
      ask: async (q) => {
        printed.push(q);
        const a = replies.shift();
        if (a === undefined) throw new Error(`unscripted question: ${q}`);
        return a;
      },
      askSecret: async (q) => {
        printed.push(q);
        const a = secrets.shift();
        if (a === undefined) throw new Error(`unscripted secret: ${q}`);
        return a;
      },
      out: (line) => void printed.push(line),
      now: () => Date.parse('2026-10-21T10:00:00Z'),
    };
    return { io, printed };
  }

  it('asks again until an answer is right, takes the defaults, and never prints a password', async () => {
    const { io, printed } = scripted(
      [
        'Iatreio', 'iatreio-test', // a name refused, then a right one
        'Οδοντιατρείο Δοκιμής',
        '123', AFM.employer, // an ΑΦΜ refused, then a right one
        '', // branches: the default, 0
        '', // inspectorate: none yet
        '', // schedule: the default, yes
        'example01',
        '0.0.0.0', '192.168.1.20', // a public-everywhere address refused
        '', '', // port 8880, no HTTPS proxy
        '', '', '', // no ntfy, no monitors
        '', // archive from: last month
        'ναι', 'ΟΧΙ ΑΚΟΜΗ', // the real register asked for, but not confirmed → trial
      ],
      ['Pass.word1', 'Pass.wordX', 'Pass.word1', 'Pass.word1'], // a mismatched repeat, then the same twice
    );
    const a = await askSetup(io);
    expect(a).toMatchObject({
      instance: 'iatreio-test',
      employerAfm: AFM.employer,
      realm: 'trial',
      bindAddress: '192.168.1.20',
      port: 8880,
      archiveFrom: '2026-09',
      branches: [{ code: '0', label: '', schedule: 'ergani', username: 'example01', password: 'Pass.word1' }],
    });
    expect(answerProblems(a)).toEqual([]);
    expect(printed.join('\n')).not.toContain('Pass.word');
    expect(printed.join('\n')).toContain('Δεν επιβεβαιώθηκε');
  });
});

describe('the terminal', () => {
  it('⛔ a hidden password never comes back: not echoed, and not recalled by ↑ at a later question', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    let shown = '';
    const output = new PassThrough();
    output.on('data', (d) => void (shown += String(d)));
    const { io, close } = terminalIo(input, output);
    try {
      const secret = io.askSecret('Κωδικός: ');
      input.write('Pass.wd1\r');
      expect(await secret).toBe('Pass.wd1');
      const next = io.ask('Επόμενο: ');
      input.write('\x1b[A\r'); // ↑, then Enter
      expect(await next).toBe('');
      expect(shown).not.toContain('Pass.wd1');
    } finally {
      close();
    }
  });
});

it('the setup ends with the offer to run it for them — no price', () => {
  const steps = nextSteps({ ...answers(), branches: answers().branches });
  expect(steps.at(-1)).toBe(FOR_YOU);
  expect(FOR_YOU).toBe('Δεν θέλετε να το φροντίζετε εσείς; Η Odontia το τρέχει για εσάς — https://odontia.ai');
  expect(FOR_YOU).not.toMatch(/€|ευρώ|\d/);
});
