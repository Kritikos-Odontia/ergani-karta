// SPDX-License-Identifier: EUPL-1.2
import { BRANCH_CODE, isValidAfm } from '../config.js';
import { INSTANCE_NAME } from '../stamp/config.js';

/**
 * THE EMPLOYER'S SETTINGS FILE — what the guided setup (`setup/cli.ts`) writes, as text, from the answers. Pure, so
 * every rule can be tested without a terminal. Docker Compose reads the file twice: as the containers' environment
 * (`env_file`), and for the address and port it publishes the page on.
 *
 * ── ⛔ WHAT IT REFUSES ───────────────────────────────────────────────────────────────────────────
 *   · a page address that is not private — loopback, the practice's own network (10/8, 172.16/12, 192.168/16) or a
 *     private overlay network such as Tailscale (100.64/10). The page names staff and takes their PINs: it is never
 *     published on the internet (docs/RULES.md, «Reach»).
 *   · a value the file format would change: quotes, `$` (Compose would read it as a variable), a backslash, a line
 *     break, or a space in a login. Better refused here than silently altered on the way to ΕΡΓΑΝΗ.
 *   · anything the services themselves would refuse at start (the ΑΦΜ check digit, the ministry's login lengths, a
 *     branch number written `01`) — said here, at the desk, rather than in a container log.
 */

export interface BranchAnswers {
  code: string;
  /** The branch's name on its page. Required when there is more than one branch. */
  label: string;
  inspectorateEmail: string;
  schedule: 'ergani' | 'none';
  username: string;
  password: string;
}

export interface SetupAnswers {
  instance: string;
  label: string;
  employerAfm: string;
  realm: 'trial' | 'production';
  branches: BranchAnswers[];
  bindAddress: string;
  port: number;
  cookieSecure: boolean;
  ntfyUrl: string;
  ntfyToken: string;
  stampHeartbeatUrl: string;
  archiveHeartbeatUrl: string;
  /** `YYYY-MM`. */
  archiveFrom: string;
}

/** Why a page address is refused, or `undefined` if it is private. IPv4 only. */
export function bindAddressProblem(address: string): string | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (m === null) return 'γράψτε μια διεύθυνση IPv4, π.χ. 192.168.1.20';
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return 'δεν είναι έγκυρη διεύθυνση IPv4';
  const isPrivate =
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  if (address === '0.0.0.0') return 'το 0.0.0.0 δημοσιεύει τη σελίδα σε ΚΑΘΕ δίκτυο του μηχανήματος — δώστε τη συγκεκριμένη ιδιωτική διεύθυνση';
  if (!isPrivate) {
    return 'η σελίδα δεν δημοσιεύεται ποτέ στο διαδίκτυο: δώστε ιδιωτική διεύθυνση (127.x, 10.x, 172.16–31.x, 192.168.x ή Tailscale 100.64–127.x)';
  }
  return undefined;
}

/** A value as the settings file can carry it unchanged — or why not. */
export function valueProblem(value: string, spaces: 'allowed' | 'refused'): string | undefined {
  if (/["'`$\\\r\n]/.test(value)) return 'χωρίς εισαγωγικά, $, \\ ή αλλαγή γραμμής';
  if (spaces === 'refused' && /\s/.test(value)) return 'χωρίς κενά';
  // Only ` #` starts a comment: Compose keeps a value that begins with `#` whole.
  if (/\s#/.test(value)) return 'χωρίς # μετά από κενό (διαβάζεται ως σχόλιο)';
  if (value !== value.trim()) return 'χωρίς κενά στην αρχή ή στο τέλος';
  return undefined;
}

/** Every problem with the answers, in Greek, in the order asked. Empty: the file can be written. */
export function answerProblems(a: SetupAnswers): string[] {
  const problems: string[] = [];
  const check = (what: string, problem: string | undefined) => {
    if (problem !== undefined) problems.push(`${what}: ${problem}`);
  };
  check('Σύντομο όνομα', INSTANCE_NAME.test(a.instance) ? undefined : 'μικρά λατινικά, ψηφία και παύλες, 2–31 χαρακτήρες, π.χ. iatreio-kentro');
  check('Όνομα στη σελίδα', a.label.trim() === '' ? 'δώστε όνομα' : valueProblem(a.label, 'allowed'));
  check('ΑΦΜ εργοδότη', isValidAfm(a.employerAfm) ? undefined : 'δεν είναι έγκυρος ΑΦΜ (9 ψηφία, ψηφίο ελέγχου)');
  if (a.branches.length === 0) problems.push('Παραρτήματα: τουλάχιστον ένα (η έδρα είναι το 0)');
  const codes = a.branches.map((b) => b.code);
  if (new Set(codes).size !== codes.length) problems.push('Παραρτήματα: ένα παράρτημα δύο φορές');
  for (const b of a.branches) {
    const at = `Παράρτημα ${b.code}`;
    check(at, BRANCH_CODE.test(b.code) ? undefined : 'ο αριθμός όπως στην ΕΡΓΑΝΗ, χωρίς μηδενικά μπροστά (0, 1, 2…)');
    if (a.branches.length > 1 && b.label.trim() === '') problems.push(`${at}: δώστε όνομα (π.χ. «Κέντρο»)`);
    if (b.label !== '') check(`${at}, όνομα`, b.label.length > 40 ? 'ως 40 χαρακτήρες' : valueProblem(b.label, 'allowed'));
    if (b.inspectorateEmail !== '') {
      check(
        `${at}, email Επιθεώρησης`,
        /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(b.inspectorateEmail) ? valueProblem(b.inspectorateEmail, 'refused') : 'δεν μοιάζει με email',
      );
    }
    check(`${at}, χρήστης ΕΡΓΑΝΗ`, b.username.length < 8 || b.username.length > 20 ? '8–20 χαρακτήρες' : valueProblem(b.username, 'refused'));
    check(`${at}, κωδικός ΕΡΓΑΝΗ`, b.password.length < 8 || b.password.length > 12 ? '8–12 χαρακτήρες' : valueProblem(b.password, 'refused'));
  }
  check('Διεύθυνση σελίδας', bindAddressProblem(a.bindAddress));
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) problems.push('Θύρα: 1024–65535');
  if ((a.ntfyUrl === '') !== (a.ntfyToken === '')) problems.push('Ειδοποιήσεις: διεύθυνση και token μαζί, ή κανένα από τα δύο');
  if (a.ntfyUrl !== '') {
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9_-]{1,64}$/.test(a.ntfyUrl)) problems.push('Ειδοποιήσεις: https://<ο δικός σας ntfy>/<topic>');
    else if (/(^|\.)ntfy\.sh$/i.test(new URL(a.ntfyUrl).hostname.replace(/\.+$/, ''))) {
      problems.push('Ειδοποιήσεις: ποτέ το δημόσιο ntfy.sh — μια ειδοποίηση γράφει το όνομα του εργαζομένου');
    }
    check('Ειδοποιήσεις, token', valueProblem(a.ntfyToken, 'refused'));
  }
  for (const [what, url] of [['Παρακολούθηση σελίδας', a.stampHeartbeatUrl], ['Παρακολούθηση αρχείου', a.archiveHeartbeatUrl]] as const) {
    if (url === '') continue;
    if (!/^https?:\/\/\S+$/.test(url)) problems.push(`${what}: http(s) διεύθυνση`);
    else check(what, valueProblem(url, 'refused'));
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.archiveFrom)) problems.push('Αρχείο από: YYYY-MM');
  return problems;
}

/** The file's text. ⛔ Call only after `answerProblems` came back empty — it is asserted again here. */
export function settingsFile(a: SetupAnswers, writtenAt: string): string {
  const problems = answerProblems(a);
  if (problems.length > 0) throw new Error(`the answers are not complete: ${problems.join('; ')}`);
  const lines = [
    '# The employer\'s settings — written by `ergani setup`. Docker Compose reads this file (docs/INSTALL.md).',
    '# ⛔ It holds the restricted ΕΡΓΑΝΗ logins: keep it private (it is written 0600), never in git, never in an email.',
    `# Written ${writtenAt}.`,
    '',
    '# ── The employer ──────────────────────────────────────────────────────────────────────────────',
    '# ⛔ The project name names the Docker volumes that ARE the five-year record: never change it once installed.',
    `COMPOSE_PROJECT_NAME=ergani-${a.instance}`,
    `STAMP_INSTANCE=${a.instance}`,
    `STAMP_LABEL=${a.label}`,
    `ERGANI_EMPLOYER_AFM=${a.employerAfm}`,
    '# 02 = a restricted user (Χρήστης Παραρτήματος) — never the employer\'s master codes.',
    'ERGANI_USERTYPE=02',
    ...(a.realm === 'production'
      ? ['# ⚠⚠ THE REAL REGISTER: every card stamped is a real declaration about a real person.', 'ERGANI_ENV=production', 'ERGANI_CONFIRM_PRODUCTION=yes']
      : [
          '# The ΕΡΓΑΝΗ trial: what is filed there is marked «ΑΚΥΡΟ». To go live, install again in a NEW folder with a new',
          '# short name (docs/INSTALL.md §2): the stores remember their realm and refuse the other, so never edit this line.',
          'ERGANI_ENV=trial',
        ]),
    '',
    '# ── The branches (the seat is 0) — one restricted login each ─────────────────────────────────────',
    `ERGANI_BRANCHES=${a.branches.map((b) => b.code).join(',')}`,
    ...a.branches.flatMap((b) => [
      '',
      `ERGANI_BRANCH_${b.code}_USERNAME=${b.username}`,
      `ERGANI_BRANCH_${b.code}_PASSWORD=${b.password}`,
      ...(b.label === '' ? [] : [`STAMP_BRANCH_${b.code}_LABEL=${b.label}`]),
      `STAMP_BRANCH_${b.code}_INSPECTORATE_EMAIL=${b.inspectorateEmail}`,
      `STAMP_BRANCH_${b.code}_SCHEDULE=${b.schedule}`,
    ]),
    '',
    '# ── Where the page is published: a PRIVATE address of this machine (never the internet) ─────────────',
    `ERGANI_BIND_ADDRESS=${a.bindAddress}`,
    `ERGANI_PORT=${a.port}`,
    `STAMP_COOKIE_SECURE=${a.cookieSecure ? 'yes' : 'no'}`,
    '',
    '# ── Optional: the owner\'s phone (your own ntfy server, docs/NOTIFICATIONS.md) and the monitors ────────',
    ...(a.ntfyUrl === '' ? ['# NTFY_URL=', '# NTFY_TOKEN='] : [`NTFY_URL=${a.ntfyUrl}`, `NTFY_TOKEN=${a.ntfyToken}`]),
    a.stampHeartbeatUrl === '' ? '# STAMP_HEARTBEAT_URL=' : `STAMP_HEARTBEAT_URL=${a.stampHeartbeatUrl}`,
    a.archiveHeartbeatUrl === '' ? '# ARCHIVE_HEARTBEAT_URL=' : `ARCHIVE_HEARTBEAT_URL=${a.archiveHeartbeatUrl}`,
    '',
    '# ── The monthly archive: the first month it keeps ─────────────────────────────────────────────────',
    `ARCHIVE_FROM=${a.archiveFrom}`,
    '',
  ];
  return lines.join('\n');
}
