// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { ERGANI_BASE_URLS, Secret, branchCodesOf, isValidAfm, loadConfig, loadEmployerConfig } from '../src/config.js';
import { AFM } from './fixtures/people.js';

/**
 * ⚠ Every ΑΦΜ in this file is FABRICATED (test/fixtures/people.ts says how), or fails the mod-11 checksum on
 * purpose. docs/RULES.md rule 9: no real identifier is a test fixture.
 */

const VALID_AFM = AFM.employer;
const VALID_AFM_2 = AFM.alfa;
/** VALID_AFM's first eight digits. */
const STEM = VALID_AFM.slice(0, 8);

describe('isValidAfm', () => {
  it('accepts a well-formed ΑΦΜ', () => {
    expect(isValidAfm(VALID_AFM)).toBe(true);
    expect(isValidAfm(VALID_AFM_2)).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    // Same eight leading digits, every other final digit must fail — this is what makes the
    // checksum worth having rather than a length check wearing a costume.
    for (const last of '0123456789'.replace(VALID_AFM.slice(8), '')) {
      expect(isValidAfm(`${STEM}${last}`)).toBe(false);
    }
  });

  it('rejects a transposition, which is the typo the checksum exists to catch', () => {
    // 000002017 → 000020017: the 2 and the 0 beside it swapped.
    expect(isValidAfm(`${VALID_AFM.slice(0, 4)}${VALID_AFM[5]}${VALID_AFM[4]}${VALID_AFM.slice(6)}`)).toBe(false);
  });

  it('rejects wrong lengths and non-digits', () => {
    expect(isValidAfm('12345678')).toBe(false);
    expect(isValidAfm(`${VALID_AFM}0`)).toBe(false);
    expect(isValidAfm(`${STEM}X`)).toBe(false);
    expect(isValidAfm('')).toBe(false);
    expect(isValidAfm(` ${VALID_AFM}`)).toBe(false);
  });

  it('rejects nine identical digits, which the mod-11 alone would let through', () => {
    // Guards the explicit repdigit branch: 000000000 sums to 0 and 0 % 11 % 10 === 0, so the
    // arithmetic accepts it. Deleting that branch must turn this red.
    expect(isValidAfm('000000000')).toBe(false);
    expect(isValidAfm('111111111')).toBe(false);
  });
});

describe('Secret', () => {
  const s = new Secret('hunter2-not-real');

  it('exposes the value only through expose()', () => {
    expect(s.expose()).toBe('hunter2-not-real');
  });

  it('redacts through JSON.stringify', () => {
    expect(JSON.stringify({ password: s })).toBe('{"password":"[redacted]"}');
  });

  it('redacts through string interpolation', () => {
    expect(`${s}`).toBe('[redacted]');
    expect(String(s)).toBe('[redacted]');
  });

  it('redacts through util.inspect, which is what console.log of an object uses', () => {
    expect(inspect(s)).toBe('[redacted]');
    expect(inspect({ nested: { password: s } })).not.toContain('hunter2');
  });
});

describe('loadConfig', () => {
  const ok: NodeJS.ProcessEnv = {
    ERGANI_EMPLOYER_AFM: VALID_AFM,
    ERGANI_BRANCH_0_USERNAME: 'example01',
    ERGANI_BRANCH_0_PASSWORD: 'Passw0rd.x',
    ERGANI_USERTYPE: '02',
  };

  it('parses a complete environment', () => {
    const c = loadConfig(ok);
    expect(c.employerAfm).toBe(VALID_AFM);
    expect(c.erganiUsername).toBe('example01');
    expect(c.erganiUsertype).toBe('02');
    expect(c.erganiPassword.expose()).toBe('Passw0rd.x');
  });

  it('defaults to the one branch "0" and keeps it a string, as Card_v1.xsd types f_aa', () => {
    expect(loadConfig(ok).branchCode).toBe('0');
    expect(loadEmployerConfig(ok).branches.map((b) => b.branchCode)).toEqual(['0']);
  });

  it('gives every branch its own login, and a branch with none stops the start', () => {
    const two = { ...ok, ERGANI_BRANCHES: '0,3', ERGANI_BRANCH_3_USERNAME: 'example03', ERGANI_BRANCH_3_PASSWORD: 'Passw0rd.3' };
    const employer = loadEmployerConfig(two);
    expect(employer.branches.map((b) => [b.branchCode, b.erganiUsername, b.erganiPassword.expose()])).toEqual([
      ['0', 'example01', 'Passw0rd.x'],
      ['3', 'example03', 'Passw0rd.3'],
    ]);
    expect(loadConfig(two, '3').erganiUsername).toBe('example03');
    expect(() => loadConfig(two)).toThrow(/2 branches/);
    expect(() => loadConfig(two, '7')).toThrow(/not in ERGANI_BRANCHES/);
    expect(() => loadEmployerConfig({ ...ok, ERGANI_BRANCHES: '0,3' })).toThrow(/ERGANI_BRANCH_3_USERNAME/);
  });

  it('refuses a branch list that is not plain branch numbers, or that repeats one', () => {
    for (const bad of ['', '-1', '1.5', 'A', '123456', '01', '0,,1', '0,0']) {
      expect(() => branchCodesOf(bad), bad).toThrow();
      expect(() => loadConfig({ ...ok, ERGANI_BRANCHES: bad })).toThrow();
    }
    expect(branchCodesOf(' 0 , 12')).toEqual(['0', '12']);
  });

  it('defaults to the trial realm, whose filings the ministry marks ΑΚΥΡΟ', () => {
    const c = loadConfig(ok);
    expect(c.erganiRealm).toBe('trial');
    expect(c.erganiBaseUrl).toBe('https://trialv2eservices.yeka.gr/WebservicesAPI/api');
    expect(loadConfig({ ...ok, ERGANI_ENV: 'trial' }).erganiBaseUrl).toBe(ERGANI_BASE_URLS.trial);
  });

  it('reaches production only with the separate opt-in', () => {
    expect(() => loadConfig({ ...ok, ERGANI_ENV: 'production' })).toThrow(/ERGANI_CONFIRM_PRODUCTION/);
    const c = loadConfig({ ...ok, ERGANI_ENV: 'production', ERGANI_CONFIRM_PRODUCTION: 'yes' });
    expect(c.erganiRealm).toBe('production');
    expect(c.erganiBaseUrl).toBe('https://eservices.yeka.gr/WebservicesAPI/api');
  });

  it('accepts only the exact opt-in value, and refuses one left behind in another realm', () => {
    for (const almost of ['true', '1', 'YES', '']) {
      expect(() =>
        loadConfig({ ...ok, ERGANI_ENV: 'production', ERGANI_CONFIRM_PRODUCTION: almost }),
      ).toThrow();
    }
    expect(() => loadConfig({ ...ok, ERGANI_CONFIRM_PRODUCTION: 'yes' })).toThrow();
    expect(() => loadConfig({ ...ok, ERGANI_ENV: 'trial', ERGANI_CONFIRM_PRODUCTION: 'yes' })).toThrow();
  });

  it('refuses an unknown realm rather than guessing one', () => {
    for (const realm of ['prod', 'Production', 'test', '']) {
      expect(() => loadConfig({ ...ok, ERGANI_ENV: realm })).toThrow();
    }
  });

  it('lets a test point the client at a local fake', () => {
    const c = loadConfig({ ...ok, ERGANI_BASE_URL: 'http://localhost:9999/api' });
    expect(c.erganiRealm).toBe('local');
    expect(c.erganiBaseUrl).toBe('http://localhost:9999/api');
    expect(loadConfig({ ...ok, ERGANI_BASE_URL: 'http://127.0.0.1:4010/api' }).erganiBaseUrl).toBe(
      'http://127.0.0.1:4010/api',
    );
  });

  it('never lets the local-fake escape hatch reach an ΕΡΓΑΝΗ host, or anywhere real', () => {
    for (const url of [
      ERGANI_BASE_URLS.production,
      ERGANI_BASE_URLS.trial,
      'https://eservices.yeka.gr./WebservicesAPI/api',
      'https://203.0.113.10/WebservicesAPI/api',
      'https://example.com/api',
      'not a url',
    ]) {
      expect(() => loadConfig({ ...ok, ERGANI_BASE_URL: url })).toThrow(/local fake/);
    }
  });

  it('refuses the local-fake URL combined with a realm — one knob decides where', () => {
    expect(() =>
      loadConfig({ ...ok, ERGANI_BASE_URL: 'http://127.0.0.1:4010/api', ERGANI_ENV: 'trial' }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...ok,
        ERGANI_BASE_URL: 'http://127.0.0.1:4010/api',
        ERGANI_ENV: 'production',
        ERGANI_CONFIRM_PRODUCTION: 'yes',
      }),
    ).toThrow();
  });

  it('refuses a malformed employer ΑΦΜ rather than letting ΕΡΓΑΝΗ reject it later', () => {
    expect(() => loadConfig({ ...ok, ERGANI_EMPLOYER_AFM: `${STEM}${(Number(VALID_AFM[8]) + 1) % 10}` })).toThrow();
    expect(() => loadConfig({ ...ok, ERGANI_EMPLOYER_AFM: undefined })).toThrow();
  });

  it('enforces the ministry password bounds (8–12), catching a truncated secret at boot', () => {
    expect(() => loadConfig({ ...ok, ERGANI_BRANCH_0_PASSWORD: 'short7!' })).toThrow();
    expect(() => loadConfig({ ...ok, ERGANI_BRANCH_0_PASSWORD: 'thirteenChars' })).toThrow();
  });

  it('enforces the ministry username bounds (8–20)', () => {
    expect(() => loadConfig({ ...ok, ERGANI_BRANCH_0_USERNAME: 'short' })).toThrow();
    expect(() => loadConfig({ ...ok, ERGANI_BRANCH_0_USERNAME: 'a'.repeat(21) })).toThrow();
  });

  it('refuses an unknown Usertype — there is no vendor or delegate identity to invent', () => {
    expect(() => loadConfig({ ...ok, ERGANI_USERTYPE: '04' })).toThrow();
  });

  /**
   * ⚠⚠ THE ONE THAT MATTERS. A boot failure is the most likely moment for a credential to reach a
   * log, a terminal or a crash reporter, because the whole config is right there in the exception.
   * This asserts the failure path stays quiet — and it is a real risk, not a hypothetical: zod's
   * error shape is a dependency, and "it reports the path, not the value" is an assumption that can
   * stop being true on a version bump.
   */
  it('never puts the password in a validation error', () => {
    const secret = 'S3cret.pw!';
    for (const env of [
      { ...ok, ERGANI_BRANCH_0_PASSWORD: secret, ERGANI_EMPLOYER_AFM: 'nope' },
      // The login's own error path: a username too short beside a real-looking password, and a password too long.
      { ...ok, ERGANI_BRANCH_0_PASSWORD: secret, ERGANI_BRANCH_0_USERNAME: 'short' },
      { ...ok, ERGANI_BRANCH_0_PASSWORD: `${secret}xyz` },
    ]) {
      let message = '';
      try {
        loadConfig(env);
      } catch (e) {
        message = e instanceof Error ? `${e.message}${JSON.stringify(e)}` : String(e);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });
});
