// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';
import { ERGANI_BASE_URLS } from '../src/config.js';
import { LiveCallAttemptedError } from './setup.js';

/**
 * The fence in `test/setup.ts` guards every other test file in this repo. A guard nothing exercises
 * is decoration — and a fence whose TRIGGER is broken passes its own logic tests while never firing
 * on anything real. So this asserts both halves separately:
 *   · the trigger — a plain `fetch(...)` from inside a test is intercepted at all;
 *   · the logic  — it fires on the ΕΡΓΑΝΗ hosts and stays out of the way of everything else.
 *
 * ⛔ Never mutation-test a host case by deleting that host from `BLOCKED_HOSTS`: the test would then
 * make the very live call the fence exists to stop. Mutate the URL in the test to a `.invalid` host.
 */
describe('the live-call fence', () => {
  it('fires on the production host', async () => {
    await expect(
      fetch('https://eservices.yeka.gr/WebservicesAPI/api/Authentication', { method: 'POST' }),
    ).rejects.toBeInstanceOf(LiveCallAttemptedError);
  });

  it('fires on the ΕΡΓΑΝΗ ΙΙ trial host — the default realm, and still a live government system', async () => {
    await expect(
      fetch('https://trialv2eservices.yeka.gr/WebservicesAPI/api/Authentication', { method: 'POST' }),
    ).rejects.toBeInstanceOf(LiveCallAttemptedError);
  });

  it('fires on the old ΕΡΓΑΝΗ I trial host too, which is dead but still in every public SDK', async () => {
    await expect(fetch('https://trialeservices.yeka.gr/api/Authentication')).rejects.toBeInstanceOf(
      LiveCallAttemptedError,
    );
  });

  it('fires on every base the config can resolve to, so moving the default cannot outrun it', async () => {
    // Coupled to the config on purpose: a new realm, or a base moved to a new host, turns this red
    // until the fence covers it. That is the exact hole the move to a trial default opened.
    for (const base of Object.values(ERGANI_BASE_URLS)) {
      await expect(fetch(`${base}/Lookup/Submissions`)).rejects.toBeInstanceOf(LiveCallAttemptedError);
    }
  });

  it('fires however the URL was built — a Request object is not an escape hatch', async () => {
    await expect(
      fetch(new Request('https://eservices.yeka.gr/WebservicesAPI/api/Lookup/Submissions')),
    ).rejects.toBeInstanceOf(LiveCallAttemptedError);
    await expect(
      fetch(new URL('https://eservices.yeka.gr/WebservicesAPI/api/Lookup/Submissions')),
    ).rejects.toBeInstanceOf(LiveCallAttemptedError);
  });

  it('does not block a local fake, which is how the client will actually be tested', async () => {
    // Nothing is listening on this port, so a connection error proves the fence let it through —
    // whereas LiveCallAttemptedError would prove it wrongly blocked a legitimate target.
    await expect(fetch('http://127.0.0.1:1/nope')).rejects.not.toBeInstanceOf(
      LiveCallAttemptedError,
    );
  });
});
