// SPDX-License-Identifier: EUPL-1.2
import type { Config } from '../config.js';
import {
  AuthResponse,
  SubmissionType,
  WORK_CARD_CODE,
  type SubmissionResult,
  type WorkCardSubmission,
} from './types.js';

/**
 * The ΕΡΓΑΝΗ ΙΙ client. Eight routes, one of which does all the work.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────────────────────────
 * It is not a port of the public Python SDK. That SDK constructs a fresh `ErganiAuthentication` —
 * a full username/password POST — on EVERY call, which the ministry's own Παράρτημα ΙΙ §4
 * «Λανθασμένη χρήση» names as anti-pattern #1, and it has no retry or refresh handling. Inheriting
 * it would mean being rate-limited out of a fifteen-minute compliance window. docs/RULES.md rule 8.
 *
 * It also does not carry the `rejected`/`unknown` distinction a fiscal-document client is built
 * around. That machinery exists to stop a lost POST response minting a second immutable receipt (ΑΠΥ).
 * **Card events are idempotent-by-latest and have no cancel path**, so a retry re-states the same
 * fact rather than duplicating a document — the failure mode does not exist here, and importing its
 * defence would be cargo cult. docs/RULES.md rule 3.
 */

/** A transport seam, so tests can drive the client without a network. Defaults to global fetch. */
export type Transport = typeof fetch;

/**
 * An ΕΡΓΑΝΗ error carrying the response verbatim.
 *
 * ⚠ Every documented failure is HTTP 400 with a JSON body `{"message": "<a Greek sentence>"}` and no
 * error code — the sentence is a FIELD. It may carry a literal `\n`, the two characters and not a
 * line break: the guide's wire body reads `"Για το Παράρτημα: 0\\nΤο ΑΦΜ δεν αντιστοιχεί στον
 * συνδεδεμένο εργοδότη."` (18.02.2026, §2.1.6 and §2.2.1). There is deliberately no
 * classification here: the ministry can reword these without notice, and a regex over prose is a
 * guard that silently stops guarding. Keep the string, show it to a human, and classify only what
 * has actually been observed in the wild. docs/RULES.md rule 8.
 * ⓘ The one status that IS classified is 429 — see `ErganiRateLimitedError`. It is documented, and
 * it is a status code, not prose.
 */
export class ErganiError extends Error {
  readonly status: number;
  /** The response body exactly as received — the only durable evidence of what went wrong. */
  readonly body: string;
  /**
   * The ministry's sentence, lifted out of `{"message": …}` — what a human should be shown.
   * `undefined` when the body is not that shape, and then `body` is all there is.
   * ⓘ Extracted rather than shown inside its JSON because JSON is not what a person reads: quotes
   * and backslashes arrive escaped, and a server may escape every Greek letter as `\uXXXX`. Nothing
   * else is touched — the guide's literal `\n` stays two characters; it is not ours to reformat.
   */
  readonly ministryMessage: string | undefined;

  constructor(status: number, body: string, context: string) {
    const ministryMessage = ministryMessageOf(body);
    super(`ΕΡΓΑΝΗ ${context} failed with HTTP ${status}: ${ministryMessage ?? body}`);
    this.name = 'ErganiError';
    this.status = status;
    this.body = body;
    this.ministryMessage = ministryMessage;
  }
}

function ministryMessageOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const { message } = parsed;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Not JSON — plain prose, or nothing. `body` already holds it verbatim.
  }
  return undefined;
}

/**
 * ΕΡΓΑΝΗ kept answering 429 Too Many Requests after every backoff step.
 *
 * ⚠⚠ 429 is DOCUMENTED BEHAVIOUR, not a surprise: «το σύνολο των κλήσεων εμπεριέχει έλεγχο ορθής
 * χρήσης και περιορισμό κλήσεων και σε όποια περίπτωση γίνει υπέρβαση επιστρέφεται 429 Too Many
 * Requests» (Παράρτημα ΙΙ §3). So it is answered with a wait, never treated as a generic 4xx, and
 * surfaces as its own type only once the waiting is exhausted — "try later", not "your request is
 * wrong". Still an `ErganiError`, so the body is kept verbatim like any other.
 */
export class ErganiRateLimitedError extends ErganiError {
  constructor(body: string, context: string) {
    super(429, body, context);
    this.name = 'ErganiRateLimitedError';
  }
}

/**
 * ── THE TOKEN LOOP, AS THE MINISTRY PRESCRIBES IT (Παράρτημα ΙΙ §2–§3) ────────────────────────────
 * Authenticate once and hold BOTH tokens. Use the access token for its three hours. On expiry — our
 * clock, the `api-token-expired: true` header, or a 401 — trade the pair at `Authentication/Refresh`
 * without re-sending the credential, for as long as the refresh token's seven days last. Only when
 * refresh itself answers 401 (the refresh token is dead) authenticate again from scratch.
 * ⚠ Refreshing before EVERY call is the ministry's anti-pattern #2 (§4), just as authenticating
 * before every call is #1: «αποφεύγεται να γίνεται κλήση για λήψη access token αν αυτό δεν είναι
 * απαραίτητο». Renewal happens only on expiry.
 *
 * ── ⛔⛔ THERE IS DELIBERATELY NO LOGOUT, AND THERE MUST NEVER BE AN AUTOMATIC ONE ───────────────
 * `POST Authentication/Logout` REVOKES THE REFRESH TOKEN (§2.1.3), which collapses the usable window
 * from seven days to the access token's three hours (Παράρτημα ΙΙ §2 step 4 — the ministry itself
 * marks logout «προαιρετική»). That harms any caller holding a session and buys nothing for a
 * monthly pull, which simply authenticates once per run. ⛔ Never call it on a timer, on shutdown,
 * on process exit, or "to be tidy" — this is not missing hygiene, it is a decision.
 * ⚠ If a human ever needs it, e.g. to cut off a leaked session: its request body is a BARE QUOTED
 * JSON STRING — the refresh token itself, `"<refreshToken>"`, exactly as the guide's example sends
 * it — not an object; the answer is a bare 200.
 */
interface CachedToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Absent when the ministry sent none — expiry then falls back to a full authentication. */
  refreshToken: string | undefined;
  /** Epoch ms, from `refreshTokenExpired`; `undefined` when absent or unparseable. */
  refreshExpiresAt: number | undefined;
}

/**
 * Refresh this many ms before the token actually expires.
 *
 * ⚠ The margin is not cosmetic. A token that expires mid-flight costs a round trip inside a
 * 15-minute statutory window, and the clock that matters (the ministry's) is not ours. Sixty
 * seconds is comfortably longer than any observed request and far shorter than the ~3h lifetime.
 */
const REFRESH_MARGIN_MS = 60_000;

/** Fallback lifetime when the response omits `accessTokenExpired`. Conservative on purpose. */
const ASSUMED_TOKEN_LIFETIME_S = 3600;

/**
 * The documented expiry signal (§2.1.1): «Στην περίπτωση λήξης επιστρέφεται στο Header η τιμή
 * api-token-expired: true». The ministry's word outranks our clock, which can drift, and a lifetime
 * the ministry «δύναται να αλλάξει».
 */
const TOKEN_EXPIRED_HEADER = 'api-token-expired';

/**
 * How long to wait after each consecutive 429 before asking again — one entry per retry, then give up
 * with `ErganiRateLimitedError`.
 *
 * ⓘ The ministry documents THAT it limits (Παράρτημα ΙΙ §3), not the limit, the window, or a
 * `Retry-After`. So: gaps that grow, together a little over a minute — long enough for a per-minute
 * window to roll over, short enough that a run fails loudly instead of hanging. A tight retry loop
 * would be exactly the misuse the ministry's «έλεγχο ορθής χρήσης» is there to catch.
 */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [2_000, 8_000, 20_000, 40_000];

export class ErganiClient {
  readonly #config: Config;
  readonly #fetch: Transport;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #token: CachedToken | undefined;

  constructor(
    config: Config,
    options: { transport?: Transport; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.#config = config;
    this.#fetch = options.transport ?? globalThis.fetch;
    // Injected so token-expiry behaviour is testable without waiting three hours.
    this.#now = options.now ?? Date.now;
    // Injected so the 429 backoff is testable without waiting a minute.
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  #url(path: string): string {
    return `${this.#config.erganiBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  /**
   * One HTTP exchange, with 429 answered by waiting (`RATE_LIMIT_BACKOFF_MS`). EVERY call goes
   * through here — authentication and refresh included, because the ministry's limit counts «το
   * σύνολο των κλήσεων».
   * ⓘ Asking again is safe: a 429 is a refusal, and even a filing is idempotent-by-latest
   * (docs/RULES.md rule 3).
   */
  async #send(path: string, init: RequestInit, context: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(this.#url(path), init);
      if (res.status !== 429) return res;
      const body = await res.text();
      const wait = RATE_LIMIT_BACKOFF_MS[attempt];
      if (wait === undefined) throw new ErganiRateLimitedError(body, context);
      await this.#sleep(wait);
    }
  }

  /**
   * Authenticate and cache the tokens. Callers do not call this — every request goes through
   * `#authorizedToken()`, which is what makes rule 8 structural rather than a convention someone
   * has to remember.
   */
  async #authenticate(): Promise<string> {
    const res = await this.#send(
      'Authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          Username: this.#config.erganiUsername,
          // ⛔ The ONLY place the credential is exposed. `.expose()` is greppable by design.
          Password: this.#config.erganiPassword.expose(),
          Usertype: this.#config.erganiUsertype,
        }),
      },
      'authentication',
    );

    const text = await res.text();
    if (!res.ok) {
      // ⚠ `text` is the ΕΡΓΑΝΗ response, never our request — the password cannot reach this path.
      throw new ErganiError(res.status, text, 'authentication');
    }
    return this.#store(text);
  }

  /**
   * Trade the held pair for a fresh one WITHOUT the credential (§2.1.2). The body is
   * `{AccessToken, RefreshToken}` — the spent access token travels with its refresh token, by design.
   * A 401 here means the refresh token itself is dead: start again from the credential, which is the
   * ministry's own step 3 (Παράρτημα ΙΙ §2). Any other failure is surfaced, not guessed at.
   */
  async #refresh(accessToken: string, refreshToken: string): Promise<string> {
    const res = await this.#send(
      'Authentication/Refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ AccessToken: accessToken, RefreshToken: refreshToken }),
      },
      'Authentication/Refresh',
    );

    const text = await res.text();
    if (res.status === 401) return this.#authenticate();
    if (!res.ok) throw new ErganiError(res.status, text, 'Authentication/Refresh');
    return this.#store(text);
  }

  /** Cache what `Authentication` or `Authentication/Refresh` returned — the two share one shape. */
  #store(text: string): string {
    const parsed = AuthResponse.parse(JSON.parse(text));
    const lifetime = parsed.accessTokenExpired ?? ASSUMED_TOKEN_LIFETIME_S;
    const refreshExpiresAt =
      parsed.refreshTokenExpired === undefined ? NaN : Date.parse(parsed.refreshTokenExpired);
    this.#token = {
      accessToken: parsed.accessToken,
      expiresAt: this.#now() + lifetime * 1000,
      refreshToken: parsed.refreshToken,
      refreshExpiresAt: Number.isNaN(refreshExpiresAt) ? undefined : refreshExpiresAt,
    };
    return parsed.accessToken;
  }

  /** A fresh access token once the held one is spent: refresh while the refresh token lives. */
  async #renew(): Promise<string> {
    const held = this.#token;
    if (held?.refreshToken === undefined) return this.#authenticate();
    // Our clock can only spare a refresh the ministry would refuse; its 401 is the authority.
    const refreshSpent =
      held.refreshExpiresAt !== undefined &&
      this.#now() >= held.refreshExpiresAt - REFRESH_MARGIN_MS;
    if (refreshSpent) return this.#authenticate();
    return this.#refresh(held.accessToken, held.refreshToken);
  }

  async #authorizedToken(): Promise<string> {
    const cached = this.#token;
    if (cached === undefined) return this.#authenticate();
    if (this.#now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.accessToken;
    return this.#renew();
  }

  async #request(path: string, init: RequestInit, context: string): Promise<unknown> {
    const text = await this.#exchange(path, init, context);
    // An empty body is `undefined`, never `null`: the reader takes the four characters `null` from
    // EX_BASE_07 as a day with no stamps (measured), and nothing — an empty 200, a 204 — has never
    // been observed there. Collapsing the two would store an unseen answer as «read, no stamp».
    return text === '' ? undefined : JSON.parse(text);
  }

  /** One authorised exchange, the body returned as the text received. */
  async #exchange(path: string, init: RequestInit, context: string): Promise<string> {
    const send = (token: string): Promise<Response> =>
      this.#send(
        path,
        {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
        },
        context,
      );

    let res = await send(await this.#authorizedToken());
    const tokenSpent =
      res.status === 401 || res.headers.get(TOKEN_EXPIRED_HEADER)?.toLowerCase() === 'true';
    if (!res.ok && tokenSpent) {
      // The ministry says the token is spent, whatever our clock thinks. Renew and repeat the failed
      // call ONCE — «Το νέο access token, μπορεί να χρησιμοποιηθεί για να πραγματοποιηθεί η κλήση
      // που απέτυχε» (Παράρτημα ΙΙ §2). A second refusal is surfaced below, never looped on.
      await res.body?.cancel();
      res = await send(await this.#renew());
    }

    const text = await res.text();
    if (!res.ok) throw new ErganiError(res.status, text, context);
    return text;
  }

  /** The employer's ACTIVE submission types. `WRKCardSE` must be among them. */
  async listSubmissions(): Promise<SubmissionType[]> {
    const body = await this.#request('Lookup/Submissions', { method: 'GET' }, 'Lookup/Submissions');
    // ⚠ The ministry may wrap the array. Accept either rather than
    // throwing on a difference that does not matter, and record what was actually seen.
    const items = Array.isArray(body) ? body : ((body as { items?: unknown[] })?.items ?? []);
    return items.map((i) => SubmissionType.parse(i));
  }

  /**
   * The LIVE schema for a submission type.
   * ⚠ `GET /Documents/{code}` returns the SCHEMA, not your filed data. There is no per-submission
   * read-back; do not mistake this for one.
   */
  async describeSubmission(code: string = WORK_CARD_CODE): Promise<unknown> {
    return this.#request(`Documents/${code}`, { method: 'GET' }, `Documents/${code} (schema)`);
  }

  /**
   * The runtime catalogue of read services (`EX_BASE_*`).
   * ⚠ Undocumented and PER-EMPLOYER: the same code returns 200 for one ΑΦΜ and 400 «Service Code is
   * not authenticate to specific User» for another. Never assume a service is available.
   */
  async listServices(): Promise<unknown> {
    return this.#request('WebServices/ServicesList', { method: 'GET' }, 'WebServices/ServicesList');
  }

  /**
   * Invoke a read service by code.
   * ⚠ Reads are limited to «ημ/νιες προηγούμενου μήνα και πίσω» — this reconciles LAST month, never
   * today. Any UI built on it must say so rather than implying a freshness the API cannot deliver.
   */
  async executeService(serviceCode: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#request(
      'WebServices/ExecuteService',
      { method: 'POST', body: JSON.stringify({ ServiceCode: serviceCode, ...params }) },
      `ExecuteService ${serviceCode}`,
    );
  }

  /**
   * FILE A WORK-CARD SUBMISSION. ⛔⛔ THE ONLY WRITE IN THIS CLIENT, AND IT IS LEGALLY BINDING.
   *
   * In production, every call is a declaration to a government register about a named real person's
   * working time, with no cancel path afterwards — a mistake is corrected only by filing again. (The
   * trial realm marks its filings ΑΚΥΡΟ; see `ERGANI_BASE_URLS` in config.ts.) No test may call this
   * against anything but the local fake, `test/fake/ergani-fake.ts`. docs/RULES.md rule 9.
   */
  async submitWorkCard(submission: WorkCardSubmission): Promise<SubmissionResult> {
    const body = await this.#request(
      `Documents/${WORK_CARD_CODE}`,
      { method: 'POST', body: JSON.stringify(submission) },
      `Documents/${WORK_CARD_CODE} (submit)`,
    );
    // ⚠ Returned as-received rather than narrowed. The protocol number is the only evidence the
    // filing happened, and discarding an unexpected field would discard the evidence with it.
    return body as SubmissionResult;
  }

  /**
   * THE PROOF PDF of a filed submission — guide §2.1.8, «Documents (Διαδικασία διάθεσης υποβληθείσας δήλωσης
   * υποβολής)»: `GET Documents/{code}?protocol={αριθμός πρωτοκόλλου}&submittedDate={yyyymmdd}`, «Το έντυπο
   * επιστρέφεται σε μορφή Base64». A read: it files nothing.
   *
   * ⭐ MEASURED (production, 2026-10-21): ΕΡΓΑΝΗ answers HTTP 200 with a JSON OBJECT —
   * `{"message": {…}, "document": "<Base64 PDF>", "documentName": "<name>"}` — and the PDF is its `document` field
   * (`pdfOfBase64Answer`). The bytes must decode to a real PDF (`%PDF-`), or this throws: a receipt is evidence, and
   * an answer that is not a PDF is never stored as one.
   * ⚠ `submittedDate` wants `yyyymmdd`, while the POST hands back `submitDate` as `DD/MM/YYYY HH:mm`
   * (`yyyymmddOfSubmitDate`).
   */
  async fetchSubmissionPdf(protocol: string, submitDate: string, code: string = WORK_CARD_CODE): Promise<Buffer> {
    const query = `protocol=${encodeURIComponent(protocol)}&submittedDate=${yyyymmddOfSubmitDate(submitDate)}`;
    const text = await this.#exchange(`Documents/${code}?${query}`, { method: 'GET' }, `Documents/${code} (PDF)`);
    return pdfOfBase64Answer(text);
  }

  /**
   * The client's clock, epoch ms — the one injected at construction. The read services decide «today»
   * from it (exbase.ts), so a test can stand on either side of a month boundary without waiting for one.
   */
  now(): number {
    return this.#now();
  }

  /** The branch this client speaks for — `config.branchCode`, the `f_aa` of `Card_v1.xsd`. */
  get branchCode(): string {
    return this.#config.branchCode;
  }

  /** Test seam: has a token been cached? Used to assert rule 8 (no re-auth per call). */
  get hasCachedToken(): boolean {
    return this.#token !== undefined;
  }
}

/**
 * `submitDate` as the POST returns it — `DD/MM/YYYY HH:mm` (guide §2.1.6, «04/05/2022 01:13») — as the `yyyymmdd`
 * the PDF route takes. The calendar day is ΕΡΓΑΝΗ's own, as it wrote it: no time zone is applied, so a filing at
 * 00:10 on the 1st stays on the 1st.
 */
export function yyyymmddOfSubmitDate(submitDate: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: \d{2}:\d{2}(?::\d{2})?)?$/.exec(submitDate.trim());
  if (m === null) throw new Error('submitDate is not in the form DD/MM/YYYY HH:mm');
  return `${m[3]}${m[2]}${m[1]}`;
}

/**
 * The PDF inside a §2.1.8 answer, or an error. Never anything that is not a PDF.
 *   · ⭐ the MEASURED shape: a JSON object whose `document` field is the Base64 PDF (`ErganiClient.fetchSubmissionPdf`);
 *   · and, as before it was measured, a JSON string or the bare Base64 — still accepted, since the `%PDF-` check below
 *     is what decides, whatever the wrapping.
 * ⓘ Errors describe the SHAPE, never the content: the answer is a declaration about a person's working time.
 */
export function pdfOfBase64Answer(text: string): Buffer {
  let encoded = text.trim();
  if (encoded.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error('the PDF answer is not valid JSON');
    }
    const document = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['document'] : undefined;
    if (typeof document !== 'string') throw new Error('the PDF answer is an object without a «document» string');
    encoded = document;
  } else if (encoded.startsWith('"')) {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed !== 'string') throw new Error('the PDF answer is not a Base64 string');
    encoded = parsed;
  }
  encoded = encoded.replace(/\s+/g, '');
  if (encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('the PDF answer is not Base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('the PDF answer does not decode to a PDF');
  return bytes;
}
