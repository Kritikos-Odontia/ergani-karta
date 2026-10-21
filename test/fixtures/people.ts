// SPDX-License-Identifier: EUPL-1.2
/**
 * ⛔⛔ EVERY PERSON AND EMPLOYER IN THE TESTS IS FABRICATED (docs/RULES.md rule 9).
 *
 * The ΑΦΜ the code must accept (`isValidAfm`: nine digits, the mod-11 check digit) are made by ONE rule, so none is
 * borrowed from anywhere: FIVE ZEROS, a three-digit serial, and the check digit computed from those eight digits.
 *   · people:    00000 1xx c   ·   employers: 00000 2xx c
 * ⓘ A number that passes the check digit could in principle be issued to someone; a block that starts with five
 * zeros is chosen because it is not where Greek ΑΦΜ are handed out — but that cannot be proven without a registry,
 * and no registry was asked (that would itself send the number somewhere). Where a test needs only a nine-digit
 * string, it uses a number that FAILS the check digit, which no real ΑΦΜ does — the ministry's own example values
 * (`012345678`, `111111111`, `000000001`…) are of that kind.
 * The names are Greek letters and «ΠΑΡΑΔΕΙΓΜΑ»/«ΔΟΚΙΜΗ».
 */
export const AFM = {
  alfa: '000001010',
  vita: '000001021',
  gamma: '000001033',
  delta: '000001045',
  /** The employer of the tests that go through `loadEmployerConfig` (the fake's own is `FAKE_EMPLOYER_AFM`). */
  employer: '000002017',
  otherEmployer: '000002029',
} as const;

export interface TestPerson {
  afm: string;
  surname: string;
  firstName: string;
  displayName: string;
}

export const ALFA: TestPerson = { afm: AFM.alfa, surname: 'Παράδειγμα', firstName: 'Άλφα', displayName: 'Άλφα' };
export const VITA: TestPerson = { afm: AFM.vita, surname: 'Δοκιμή', firstName: 'Βήτα', displayName: 'Βήτα' };
export const GAMMA: TestPerson = { afm: AFM.gamma, surname: 'Δοκιμή', firstName: 'Γάμμα', displayName: 'Γάμμα' };
