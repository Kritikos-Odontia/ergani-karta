// SPDX-License-Identifier: EUPL-1.2
import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertOutsideCodeFolders, newRequestFolder } from '../code-folders.js';
import { branchOf, loadEmployerConfig } from '../config.js';
import { ErganiClient } from '../ergani/client.js';
import { WORK_CARD_CODE } from '../ergani/types.js';
import { WorkCardDelayReason } from '../ergani/types.js';
import { athensTime, shortGreek } from './athens.js';
import { rowToPunch } from './capture.js';
import { branchHeading, loadStampSettings } from './config.js';
import { allDevices, createEnrollment, revokeDevice } from './devices.js';
import { historyCsv, historyHtml, historyOf } from './history.js';
import { cardsMissingProof, decide, openPunches, stateOfPunch } from './outbox.js';
import { namelessSender, newEasyTopic, ntfySender, type PushSender } from './notify.js';
import { declaredDays, markQuietDay, readScheduleNow } from './schedule.js';
import {
  addPerson,
  allStaff,
  exemptPerson,
  includePerson,
  issuePin,
  personByAfm,
  personById,
  renamePerson,
  setActive,
  unlockPerson,
} from './staff.js';
import { addBranch, initStampStore, isoOf, openStampStore, storeBranches, type Instance, type StampStore } from './store.js';

/**
 * THE OWNER'S TOOL — run on the server, inside the employer's container (docs/ADMIN.md):
 *
 *   docker compose exec stamp ergani admin <command> [options]
 *
 *   init                                   create this employer's store, once, with the branches in ERGANI_BRANCHES
 *   add-branch --branch N                  a branch added to ERGANI_BRANCHES later (with its login), once
 *   add --afm … --surname … --first-name … [--display «Όνομα»] [--exempt «οδοντίατρος»]
 *   pin --afm …            a new one-time PIN (forgotten PIN); the person chooses their own at the screen
 *   unlock --afm …         lift a 10-minute lock
 *   exempt --afm … --reason …   ·   include --afm …   ·   deactivate --afm …   ·   reactivate --afm …
 *   rename --afm … [--surname …] [--first-name …] [--display …]
 *   list                   the people, who stamps, who is exempt and why
 *   enroll [--branch N] --label «Υποδοχή»    a one-time link (30 minutes) to open ONCE on that branch's reception
 *                          computer (--branch is needed only when the employer has more than one)
 *   devices   ·   revoke-device --id N
 *   cards [--date YYYY-MM-DD]   that day's cards and what became of each (default today)
 *   queue                  cards that need a human, and filed cards whose proof PDF is still missing
 *   history --afm … [--from YYYY-MM-DD] [--to YYYY-MM-DD] --out <folder>   one person's own cards (their legal
 *                          right): a Greek page and a spreadsheet file, written outside every code folder
 *   decide --card N (--reason 001|002|003 | --covered)   the owner's decision on a queued card
 *   quiet --date YYYY-MM-DD --reason «28η Οκτωβρίου»      a closed day: no «has not stamped in» alarm
 *   unquiet --date YYYY-MM-DD --reason «ανοίξαμε τελικά»   withdraw that mark (both are kept)
 *   push-test              one test push to the owner's phone — proves the topic, the login and the phone (in the
 *                          easy mode, the fixed ΔΟΚΙΜΗ sentence)
 *   easy-topic             a new random topic for the easy mode (NTFY_EASY_TOPIC) — never type one by hand
 *   check [--branch N]     READ ONLY, for every branch (or one): sign in with its login, confirm WRKCardSE is offered
 *                          to it, read today's stand-in schedule and compare its people with the list — before the
 *                          first real filing
 *
 * ⛔⛔ THERE IS NO COMMAND THAT STAMPS. The owner changes who may stamp; only the person stamps, with their own PIN,
 * at the reception page (docs/RULES.md rule 1). Do not add one — not «for a correction», not «for a test».
 * ⓘ It prints ΑΦΜ only in `list`, to the owner's own terminal. It never prints an ΕΡΓΑΝΗ login.
 */

const OWNER = 'ο εργοδότης (από τον server)';

export interface AdminIo {
  now: () => number;
  out: (line: string) => void;
  /** Tests only: the client `check` reads with for a branch (a fake). Default: a client built from the environment. */
  client?: (branch: string) => ErganiClient;
  /** Tests only: where `push-test` sends. Default: the ntfy topic from the environment. */
  send?: PushSender;
}

export async function adminCommand(argv: readonly string[], env: NodeJS.ProcessEnv, io: AdminIo): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      afm: { type: 'string' },
      surname: { type: 'string' },
      'first-name': { type: 'string' },
      display: { type: 'string' },
      exempt: { type: 'string' },
      reason: { type: 'string' },
      label: { type: 'string' },
      id: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string' },
      card: { type: 'string' },
      covered: { type: 'boolean', default: false },
      date: { type: 'string' },
      branch: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (command === 'easy-topic') {
    // Needs no settings: it is what goes INTO them.
    io.out(newEasyTopic());
    io.out('Βάλτε το στο αρχείο ρυθμίσεων ως NTFY_EASY_TOPIC=… και κρατήστε το για τον εαυτό σας: όποιος το ξέρει βλέπει τις ειδοποιήσεις.');
    return 0;
  }
  const settings = loadStampSettings(env);
  const ergani = loadEmployerConfig(env);
  const codes = ergani.branches.map((b) => b.branchCode);
  const instance: Instance = {
    name: settings.instance,
    realm: ergani.erganiRealm,
    employerAfm: ergani.employerAfm,
  };
  /** A branch's name for the owner's lists — nothing for an employer with one branch. */
  const branchName = (code: string) => (codes.length > 1 ? (settings.branches.find((b) => b.code === code)?.label ?? code) : '');
  const now = io.now();
  const out = io.out;
  const need = (name: string, value: string | undefined): string => {
    if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`);
    return value;
  };

  if (command === 'init') {
    initStampStore(settings.dbPath, instance, codes, isoOf(now)).close();
    out(`Stamping store created for «${instance.name}» (${instance.realm}, branch${codes.length > 1 ? 'es' : ''} ${codes.join(', ')}). Nothing was sent.`);
    return 0;
  }

  // ⓘ `add-branch` opens the store before its branches match the configuration — that is what it is for.
  const db = openStampStore(settings.dbPath, instance, command === 'add-branch' ? undefined : codes);
  try {
    switch (command) {
      case 'add-branch': {
        const code = branchOf(ergani, need('branch', values.branch)).branchCode;
        addBranch(db, code, isoOf(now));
        out(`Branch ${code} added: the service now starts with every branch in ERGANI_BRANCHES.`);
        return 0;
      }
      case 'add': {
        const added = await addPerson(
          db,
          {
            afm: need('afm', values.afm),
            surname: need('surname', values.surname),
            firstName: need('first-name', values['first-name']),
            displayName: values.display,
            exemptReason: values.exempt,
          },
          OWNER,
          now,
        );
        const person = personById(db, added.id);
        out(`Added «${person?.displayName}» (${person?.surname} ${person?.firstName}).`);
        if (added.oneTimePin === undefined) out(`Exempt — does not stamp. Reason recorded: ${values.exempt}`);
        else out(`One-time PIN to hand over: ${added.oneTimePin}  (at the screen they choose their own; then only they know it)`);
        return 0;
      }
      case 'pin': {
        const pin = await issuePin(db, need('afm', values.afm), OWNER, now);
        out(`New one-time PIN: ${pin}  (they choose their own at the screen)`);
        return 0;
      }
      case 'unlock':
        unlockPerson(db, need('afm', values.afm), OWNER, now);
        out('Unlocked.');
        return 0;
      case 'exempt':
        await exemptPerson(db, need('afm', values.afm), need('reason', values.reason), OWNER, now);
        out('Exempt — no longer on the page. Reason recorded.');
        return 0;
      case 'include': {
        const pin = await includePerson(db, need('afm', values.afm), OWNER, now);
        out(pin === undefined ? 'Stamps again (their PIN is unchanged).' : `Stamps again. One-time PIN: ${pin}`);
        return 0;
      }
      case 'deactivate':
      case 'reactivate':
        setActive(db, need('afm', values.afm), command === 'reactivate', OWNER, now);
        out(command === 'reactivate' ? 'Active again.' : 'Deactivated — kept in the record, no longer on the page.');
        return 0;
      case 'rename':
        renamePerson(
          db,
          need('afm', values.afm),
          { surname: values.surname, firstName: values['first-name'], displayName: values.display },
          OWNER,
          now,
        );
        out('Renamed. Cards already filed keep the name they were filed with.');
        return 0;
      case 'list':
        for (const p of allStaff(db)) {
          const status = !p.active ? 'inactive' : p.mustStamp ? 'stamps' : `EXEMPT — ${p.exemptReason}`;
          out(`${p.afm}  ${p.displayName.padEnd(14)} ${p.surname} ${p.firstName}  · ${status}${p.pinIsTemporary && p.mustStamp ? ' · has not chosen a PIN yet' : ''}`);
        }
        return 0;
      case 'enroll': {
        const branch = branchOf(ergani, values.branch).branchCode;
        const token = createEnrollment(db, branch, need('label', values.label), now);
        out(`For «${branchHeading(settings, branch)}». Open this ONCE, on that reception computer, within 30 minutes:  /enroll/${token}`);
        out('(after the page address, e.g. http://192.168.1.20:8880/enroll/…)');
        return 0;
      }
      case 'devices':
        for (const d of allDevices(db)) {
          const where = codes.length > 1 ? `  (${branchName(d.branch)})` : '';
          out(`${d.id}  ${d.label}${where}  enrolled ${d.enrolledAt}${d.revokedAt ? `  REVOKED ${d.revokedAt}` : ''}`);
        }
        return 0;
      case 'revoke-device':
        revokeDevice(db, Number(need('id', values.id)), now);
        out('Revoked: that computer no longer sees the page.');
        return 0;
      case 'cards': {
        const date = values.date ?? athensTime(now).date;
        const rows = db.prepare('SELECT * FROM punches WHERE reference_date = ? ORDER BY event_ms, id').all(date).map(rowToPunch);
        for (const p of rows) out(cardLine(db, p.id, now));
        if (rows.length === 0) out(`No cards for ${date}.`);
        return 0;
      }
      case 'queue': {
        const waiting = openPunches(db).filter((p) => stateOfPunch(db, p, now).kind === 'needs-human');
        for (const p of waiting) out(cardLine(db, p.id, now));
        if (waiting.length === 0) out('Nothing needs a human.');
        for (const missing of cardsMissingProof(db)) {
          out(`${cardLine(db, missing.punchId, now)}  · proof PDF still missing after ${missing.tries} tries (asked again daily)`);
        }
        return 0;
      }
      case 'decide': {
        const card = Number(need('card', values.card));
        if (values.covered === (values.reason !== undefined)) throw new Error('give exactly one of --reason 001|002|003 or --covered');
        const input = values.covered
          ? ({ kind: 'covered' } as const)
          : ({ kind: 'file_late', fAitiologia: WorkCardDelayReason.parse(values.reason) } as const);
        decide(db, card, input, { employeeId: undefined, label: OWNER, deviceId: undefined }, now);
        out(input.kind === 'covered' ? 'Recorded: not sent from here.' : 'Recorded: it will be sent late, with that reason, by the running service.');
        return 0;
      }
      case 'history': {
        const person = personByAfm(db, need('afm', values.afm));
        const folder = need('out', values.out);
        if (!isAbsolute(folder)) throw new Error('--out must be an absolute folder');
        assertOutsideCodeFolders(folder, '--out');
        const to = values.to ?? athensTime(now).date;
        const from = values.from ?? `${Number(to.slice(0, 4)) - 5}${to.slice(4)}`;
        const rows = historyOf(db, person.id, from, to, now, branchName);
        const name = `kartes-${person.id}-${from}-${to}`;
        // A new folder per request: the owner hands over that folder alone, never one that holds earlier requests.
        const request = newRequestFolder(folder, name, now);
        writeFileSync(join(request, `${name}.html`), historyHtml(person, rows, from, to, settings.label, isoOf(now)), { mode: 0o600 });
        writeFileSync(join(request, `${name}.csv`), historyCsv(rows), { mode: 0o600 });
        out(`${rows.length} cards written to ${request} — copy that folder alone, give it to that person only.`);
        return 0;
      }
      case 'quiet':
      case 'unquiet':
        markQuietDay(db, need('date', values.date), command === 'quiet', need('reason', values.reason), OWNER, now);
        out(
          command === 'quiet'
            ? 'Recorded: no «has not stamped in» alarm that day, at any branch. Anyone who does stamp is still filed and watched.'
            : 'Recorded: that day is a working day again — its alarms are back.',
        );
        return 0;
      case 'push-test': {
        const send =
          io.send ??
          (settings.ntfy !== undefined
            ? ntfySender(settings.ntfy.url, settings.ntfy.token)
            : settings.easyTopic !== undefined
              ? namelessSender(settings.easyTopic)
              : undefined);
        if (send === undefined) throw new Error('no phone push is configured (NTFY_URL and NTFY_TOKEN, or NTFY_EASY_TOPIC)');
        await send({
          title: `ΕΡΓΑΝΗ — ${settings.label}`,
          message: 'Δοκιμή ειδοποίησης από την κάρτα εργασίας. Αν τη βλέπετε στο κινητό, οι ειδοποιήσεις λειτουργούν.',
          priority: 4,
        }, 'test'); // the easy mode sends its own fixed ΔΟΚΙΜΗ sentence for this key
        out('Sent. ⚠ «Sent» proves only that the server took it — the pass is the owner seeing it on the phone.');
        return 0;
      }
      case 'check': {
        // ⛔ READ ONLY. Lookup/Submissions and EX_BASE_08 are reads; nothing here can file.
        const asked = values.branch === undefined ? ergani.branches : [branchOf(ergani, values.branch)];
        let failed = false;
        for (const config of asked) {
          const branch = config.branchCode;
          if (codes.length > 1) out(`── branch ${branch} (${branchName(branch)})`);
          const client = io.client?.(branch) ?? new ErganiClient(config);
          const forms = await client.listSubmissions();
          const card = forms.find((f) => f.code === WORK_CARD_CODE);
          if (card === undefined) failed = true;
          out(card === undefined ? `⛔ ${WORK_CARD_CODE} is NOT offered to this login — it cannot file cards.` : `✓ ${WORK_CARD_CODE} is offered to this login.`);
          if (settings.branches.find((b) => b.code === branch)?.scheduleFromErgani !== true) {
            out('Schedule: not read for this branch (SCHEDULE=none) — no «not stamped in» alarm here; «not stamped out» works from the open ΕΝΑΡΞΗ.');
            continue;
          }
          const today = athensTime(now).date;
          // A FRESH read, never the one held: the point is to prove this login can read the schedule now.
          const read = await readScheduleNow(db, client, now);
          if (read.rows === undefined) {
            out(`⛔ The schedule for ${read.sourceDay} (standing in for ${today}) could not be read: ${read.error ?? ''}`);
            failed = true;
            continue;
          }
          const staff = allStaff(db);
          out(`Schedule of ${read.sourceDay}, standing in for ${today}:`);
          for (const day of declaredDays(read.rows)) {
            const p = staff.find((s) => s.afm === day.afm);
            const who = p === undefined ? `${day.afm}  ⛔ NOT ON THE LIST — add them, or add them --exempt with the reason` : `${p.displayName}${p.mustStamp ? '' : ' (exempt)'}${p.active ? '' : ' (inactive)'}`;
            out(`  ${who}: ${day.off ? 'declared day off' : day.intervals.map((iv) => `${iv.start}–${iv.end}`).join(' + ') || 'no hours'}`);
          }
          // ⓘ With one branch everyone on the list should be in its schedule; with several, a person is in one of them.
          if (codes.length === 1) {
            for (const p of staff.filter((s) => s.active && s.mustStamp && !read.rows?.some((r) => r.Afm === s.afm))) {
              out(`  ${p.displayName}: on the list, but not in ΕΡΓΑΝΗ's schedule that day — check the ΑΦΜ`);
            }
          }
        }
        return failed ? 1 : 0;
      }
      default:
        throw new Error('unknown command — see docs/ADMIN.md');
    }
  } finally {
    db.close();
  }
}

function cardLine(db: StampStore, punchId: number, now: number): string {
  const row = db.prepare('SELECT * FROM punches WHERE id = ?').get(punchId);
  const p = rowToPunch(row ?? {});
  const state = stateOfPunch(db, p, now);
  const name = personById(db, p.employeeId)?.displayName ?? '—';
  const type = p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ';
  const branch = storeBranches(db).length > 1 ? `  (branch ${p.branch})` : '';
  const what =
    state.kind === 'filed'
      ? `filed${state.late ? ' (late)' : ''} — protocol ${state.protocol}`
      : state.kind === 'needs-human'
        ? `NEEDS A HUMAN (${state.why})`
        : state.kind;
  return `#${p.id}  ${shortGreek(p.eventMs)}  ${name}  ${type}${branch}  · ${what}`;
}

