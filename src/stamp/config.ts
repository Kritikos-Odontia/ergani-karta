// SPDX-License-Identifier: EUPL-1.2
import { isAbsolute } from 'node:path';
import { Secret, branchCodesOf, loadEmployerConfig, type EmployerConfig } from '../config.js';

/**
 * The stamping service's own settings, beside the ΕΡΓΑΝΗ ones (`loadEmployerConfig`, src/config.ts).
 *
 * ── ONE EMPLOYER PER INSTALLATION, EVERY BRANCH IN IT ──────────────────────────────────────────────
 * Each employer runs its own instance — its own container, store, logins, port and alerts — named by ONE name
 * (`STAMP_INSTANCE`). The store records that name, the employer's ΑΦΜ and realm at `init`, and refuses to open under
 * any other (store.ts). Nothing of one employer is ever in another's instance. Its branches each get their own page
 * (a device is enrolled at one branch), their own heading and their own Επιθεώρηση address.
 *
 * ⓘ Errors name the variable, never its value — the habit that keeps credentials out of them.
 */
export interface BranchSettings {
  /** `f_aa`, as in `ERGANI_BRANCHES`. */
  code: string;
  /** The branch's name on its page and in alarms, e.g. «Κέντρο». Empty for an employer with one branch. */
  label: string;
  /**
   * The οικεία Επιθεώρηση Εργασίας's email for the two notifications of a fault (docs/RULES.md rule 5), when known.
   * Unset ⇒ the page names the duty without an address.
   */
  inspectorateEmail: string | undefined;
  /**
   * Whether the «not stamped in» alarm reads ΕΡΓΑΝΗ's declared schedule for this branch (`ergani`, the default) or
   * reads none (`none`). ⓘ `none` is for a branch whose days are planned week by week, not by a standing schedule:
   * EX_BASE_08 answers a bare `null` for a branch with no declared schedule (measured), which the reader rightly
   * refuses, so the page would re-read every 15 minutes all day and show «Δεν διάβασα το ωράριο» every day. With
   * `none` it makes no schedule call; the «not stamped OUT» alarm, which needs only her own ΕΝΑΡΞΗ, and every card
   * alarm work as before.
   */
  scheduleFromErgani: boolean;
}

export interface StampSettings {
  /** The employer's short name on the box: lower-case letters, digits, dashes. */
  instance: string;
  /** Absolute path of the store file. ⚠ It holds ΑΦΜ and working time: never in a code folder (store.ts checks). */
  dbPath: string;
  /** Where the page listens INSIDE the process. The container sets 0.0.0.0; Docker publishes it on a private address only. */
  listenHost: string;
  port: number;
  /** The employer's name on every page, e.g. «Οδοντιατρείο Παράδειγμα». */
  label: string;
  /** One per branch, in the order of `ERGANI_BRANCHES`. */
  branches: BranchSettings[];
  /** `Secure` on the device cookie: set it when the page is served over HTTPS (behind a proxy). */
  cookieSecure: boolean;
  /**
   * The owner's phone: a self-hosted ntfy topic that needs a login (pushes NAME the person; notify.ts says why not
   * ntfy.sh). Both or neither. ⛔ Never logged, never echoed. Unset ⇒ no push; the page shows everything.
   */
  ntfy: { url: Secret; token: Secret } | undefined;
  /** A monitor's push URL, called every minute while the outbox is healthy (heartbeat.ts). ⛔ Never logged. */
  heartbeatUrl: Secret | undefined;
}

export const INSTANCE_NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** The page heading for a branch: the employer, and — when there is more than one branch — the branch. */
export function branchHeading(settings: Pick<StampSettings, 'label' | 'branches'>, code: string): string {
  const branch = settings.branches.find((b) => b.code === code);
  return settings.branches.length > 1 && branch !== undefined && branch.label !== ''
    ? `${settings.label} — ${branch.label}`
    : settings.label;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

/**
 * The branches' own settings, one per `ERGANI_BRANCHES` code, in that order. Shared by the page and the archive: the
 * archive needs `scheduleFromErgani` to read a `SCHEDULE=none` branch's EX_BASE_08 the way the page does.
 */
export function loadBranchSettings(env: NodeJS.ProcessEnv = process.env): BranchSettings[] {
  const codes = branchCodesOf(env.ERGANI_BRANCHES ?? '0');
  return codes.map((code): BranchSettings => {
    const key = (name: string) => `STAMP_BRANCH_${code}_${name}`;
    const branchLabel = (env[key('LABEL')] ?? '').trim();
    if (codes.length > 1 && branchLabel === '') {
      throw new Error(`${key('LABEL')} must name the branch: with more than one branch, each page says which it is.`);
    }
    if (branchLabel.length > 40) throw new Error(`${key('LABEL')} is at most 40 characters.`);
    // Blank is «not known»: the page then names the duty without an address.
    const email = env[key('INSPECTORATE_EMAIL')]?.trim() || undefined;
    if (email !== undefined && !EMAIL.test(email)) throw new Error(`${key('INSPECTORATE_EMAIL')} must be an email address.`);
    // ⚠ The exact word, on purpose — no trimming, no case folding: only `none` turns the reading off, and anything else
    // (blank, `NONE`, `"none"`) stops the service at start, where a monitor sees it.
    const schedule = env[key('SCHEDULE')] ?? 'ergani';
    if (schedule !== 'ergani' && schedule !== 'none') throw new Error(`${key('SCHEDULE')} must be ergani or none.`);
    return { code, label: branchLabel, inspectorateEmail: email, scheduleFromErgani: schedule === 'ergani' };
  });
}

export function loadStampSettings(env: NodeJS.ProcessEnv = process.env): StampSettings {
  const instance = env.STAMP_INSTANCE ?? '';
  if (!INSTANCE_NAME.test(instance)) {
    throw new Error('STAMP_INSTANCE must be the employer\'s short name on the box: lower-case letters, digits and dashes.');
  }
  const dbPath = env.STAMP_DB ?? '';
  if (!isAbsolute(dbPath)) throw new Error('STAMP_DB must be an absolute path to the store file.');
  const port = Number(env.STAMP_PORT ?? '8880');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STAMP_PORT must be a port number.');
  const label = (env.STAMP_LABEL ?? '').trim() || 'Κάρτα Εργασίας';
  const secure = env.STAMP_COOKIE_SECURE ?? 'no';
  if (secure !== 'yes' && secure !== 'no') throw new Error('STAMP_COOKIE_SECURE must be yes or no.');

  const branches = loadBranchSettings(env);

  const ntfyUrl = env.NTFY_URL;
  const ntfyToken = env.NTFY_TOKEN;
  if ((ntfyUrl === undefined) !== (ntfyToken === undefined)) {
    throw new Error('NTFY_URL and NTFY_TOKEN come together: the topic needs a login, because a push names the person.');
  }
  if (ntfyUrl !== undefined && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9_-]{1,64}$/.test(ntfyUrl)) {
    throw new Error('NTFY_URL must be https://<your ntfy server>/<topic>.');
  }
  // ⚠ The host as DNS reads it: «ntfy.sh.» (a trailing dot) is the same public server, so the dots go before the check.
  if (ntfyUrl !== undefined && /(^|\.)ntfy\.sh$/i.test(new URL(ntfyUrl).hostname.replace(/\.+$/, ''))) {
    throw new Error('NTFY_URL must be your own ntfy server, never ntfy.sh: on its free tier anyone who knows a topic reads it, and a push names the person.');
  }

  return {
    instance,
    dbPath,
    listenHost: env.STAMP_LISTEN_HOST ?? '127.0.0.1',
    port,
    label,
    branches,
    cookieSecure: secure === 'yes',
    ntfy:
      ntfyUrl !== undefined && ntfyToken !== undefined
        ? { url: new Secret(ntfyUrl), token: new Secret(ntfyToken) }
        : undefined,
    heartbeatUrl: heartbeatUrlOf(env, 'STAMP_HEARTBEAT_URL'),
  };
}

/** A monitor's push URL from `name`, or `undefined`. ⓘ The error names the variable only: the URL carries a token. */
export function heartbeatUrlOf(env: NodeJS.ProcessEnv, name: string): Secret | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL.`);
  return new Secret(value);
}

/** Both halves, for the service's boot. */
export function loadEverything(env: NodeJS.ProcessEnv = process.env): { ergani: EmployerConfig; stamp: StampSettings } {
  return { ergani: loadEmployerConfig(env), stamp: loadStampSettings(env) };
}
