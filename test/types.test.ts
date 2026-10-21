// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';
import {
  Card,
  CardDetail,
  SubmissionResult,
} from '../src/ergani/types.js';
import { AFM } from './fixtures/people.js';

/**
 * The wire types against `Card_v1.xsd`'s own bounds.
 *
 * ⚠ Every ΑΦΜ and name here is FABRICATED. docs/RULES.md rule 9: no real person is a test fixture.
 */

const detail = {
  f_afm: AFM.alfa,
  f_eponymo: 'ΔΟΚΙΜΑΣΤΙΚΟΣ',
  f_onoma: 'ΠΛΑΣΜΑΤΙΚΟΣ',
  f_type: '0',
  f_reference_date: '2026-09-24',
  f_date: '2026-09-24T09:00:00+03:00',
};

const card = {
  f_afm_ergodoti: '000000000',
  f_aa: '0',
  Details: { CardDetails: [detail] },
};

describe('Card', () => {
  it('takes f_aa as a string and refuses a number, which would serialise unquoted', () => {
    expect(Card.parse(card).f_aa).toBe('0');
    expect(() => Card.parse({ ...card, f_aa: 0 })).toThrow();
    expect(() => Card.parse({ ...card, f_aa: '123456' })).toThrow();
  });

  it('bounds f_afm_ergodoti to nine digits and f_comments to 200 characters', () => {
    expect(() => Card.parse({ ...card, f_afm_ergodoti: '09000004' })).toThrow();
    expect(Card.parse({ ...card, f_comments: 'α'.repeat(200) }).f_comments).toHaveLength(200);
    expect(() => Card.parse({ ...card, f_comments: 'α'.repeat(201) })).toThrow();
  });
});

describe('CardDetail', () => {
  it('bounds f_afm to nine digits', () => {
    expect(() => CardDetail.parse({ ...detail, f_afm: `${AFM.alfa}0` })).toThrow();
  });

  it('bounds f_eponymo at 50 and f_onoma at 30, the lengths a real 400 comes from', () => {
    expect(() => CardDetail.parse({ ...detail, f_eponymo: 'Ω'.repeat(50) })).not.toThrow();
    expect(() => CardDetail.parse({ ...detail, f_eponymo: 'Ω'.repeat(51) })).toThrow();
    expect(() => CardDetail.parse({ ...detail, f_onoma: 'Ω'.repeat(30) })).not.toThrow();
    expect(() => CardDetail.parse({ ...detail, f_onoma: 'Ω'.repeat(31) })).toThrow();
  });

  it('takes f_aitiologia as one of the three codes, or blank for an on-time filing', () => {
    expect(CardDetail.parse(detail).f_aitiologia).toBe('');
    for (const code of ['001', '002', '003']) {
      expect(CardDetail.parse({ ...detail, f_aitiologia: code }).f_aitiologia).toBe(code);
    }
    for (const bad of ['004', '2', 'Πρόβλημα στην Ηλεκτροδότηση']) {
      expect(() => CardDetail.parse({ ...detail, f_aitiologia: bad })).toThrow();
    }
  });
});

describe('SubmissionResult', () => {
  it('is the guide’s documented array of { id, protocol, submitDate }', () => {
    const body = [{ id: '92', protocol: 'ΕΥΣ92', submitDate: '04/05/2022 01:13' }];
    expect(SubmissionResult.parse(body)[0]?.protocol).toBe('ΕΥΣ92');
    expect(() => SubmissionResult.parse(body[0])).toThrow();
    // The old type's field name, `submissionDate`, is not the ministry's — it must not satisfy `submitDate`.
    expect(() =>
      SubmissionResult.parse([{ id: '92', protocol: 'ΕΥΣ92', submissionDate: '04/05/2022 01:13' }]),
    ).toThrow();
  });
});
