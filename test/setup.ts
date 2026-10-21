// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeAll } from 'vitest';

/**
 * THE LIVE-CALL FENCE. Installed for every test file (see `vitest.config.ts` → `setupFiles`).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A test that reaches production is not a flaky integration test — it **files a real,
 * legally-binding declaration about a real person's working time**, from a laptop or a CI runner.
 * docs/RULES.md rule 9.
 *
 * ΕΡΓΑΝΗ ΙΙ does have a sandbox — `trialv2eservices.yeka.gr`, and the config's DEFAULT realm — whose
 * filings the ministry marks «ΑΚΥΡΟ» (interoperability guide §1.1). ⛔ A test still may not reach it:
 * an unauthenticated live call from CI to a government system is not something we do, and the trial
 * register is a place to rehearse against the ministry, not to discover our own bugs — that is what
 * the local fake is for. So all three ΕΡΓΑΝΗ hosts are blocked, permanently: production, the ΕΡΓΑΝΗ ΙΙ
 * trial, and the dead ΕΡΓΑΝΗ I trial that every public SDK still defaults to.
 * ⚠ Moving the default realm is exactly the change that can outrun this set — `fence.test.ts`
 * asserts that every base the config can resolve to is blocked here.
 *
 * ── WHY A RUNTIME GUARD AND NOT A grep ──────────────────────────────────────────────────────────
 * The first version of this fence was a CI step that grepped `test/` for the production hostname.
 * It was wrong in both directions, and the false positive was immediate: `config.test.ts` asserts
 * the *default base URL*, so the honest test of a real behaviour would have reddened the build,
 * while any test that built the host from a variable — `${base}/api` — would have sailed through.
 *
 * A guard's TRIGGER is a separate property from its LOGIC. This one triggers on **any fetch from any
 * test**, which is the actual event of interest, and its logic inspects the resolved host. Both
 * halves are then themselves asserted in `fence.test.ts` — a fence nothing exercises is decoration.
 *
 * ⚠ Deliberately scoped to the network. It does not stop a test constructing the URL, importing the
 * client, or asserting on the default — all of which are legitimate and one of which is required.
 */
const BLOCKED_HOSTS = new Set([
  'eservices.yeka.gr',
  'trialv2eservices.yeka.gr',
  'trialeservices.yeka.gr',
]);

export class LiveCallAttemptedError extends Error {
  constructor(url: string) {
    super(
      `Test attempted a live call to ${url}. Tests never reach an ΕΡΓΑΝΗ host: in production this ` +
        `would file a real declaration about a real person, and even the trial register (filings ` +
        `marked ΑΚΥΡΟ) is a live government system. Use the fake transport. See docs/RULES.md rule 9.`,
    );
    this.name = 'LiveCallAttemptedError';
  }
}

const realFetch = globalThis.fetch;

/**
 * ⓘ These parameter types are derived from `fetch` itself rather than spelled out. The usual names
 * for them live in the DOM lib, and this is a Node project (`lib: ES2022`, `types: ["node"]`) —
 * widening the lib just to spell two parameters would pull the whole browser surface into a
 * server-side app's type space. Derivation also stays correct if node's own signature moves.
 * ⓘ Caught by `npm run typecheck`, not by `npm test`: vitest transpiles without typechecking, so
 * the suite was green while the build was red. Both run in CI for exactly this reason.
 */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function hostOf(input: FetchInput): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    return new URL(input.url).hostname;
  } catch {
    // A malformed URL cannot reach ΕΡΓΑΝΗ; let the caller fail on its own terms.
    return undefined;
  }
}

beforeAll(() => {
  globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
    const host = hostOf(input);
    if (host !== undefined && BLOCKED_HOSTS.has(host)) {
      // ⚠ REJECT, do not throw synchronously. Real `fetch` signals a network failure with a rejected
      // promise, so a synchronous throw would give the fence a different failure shape from the
      // thing it stands in for — and code under test that correctly handles a rejection would then
      // fail here for the wrong reason. The fence must lie about the destination, never the shape.
      return Promise.reject(new LiveCallAttemptedError(String(host)));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
