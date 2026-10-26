// SPDX-License-Identifier: EUPL-1.2
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkCardDelayReason } from '../../ergani/types.js';
import { adminCommand } from '../../stamp/admin.js';
import { athensTime } from '../../stamp/athens.js';
import { branchHeading, loadStampSettings } from '../../stamp/config.js';
import { allDevices, createEnrollment, revokeDevice } from '../../stamp/devices.js';
import { decide, openPunches, stateOfPunch } from '../../stamp/outbox.js';
import { markQuietDay } from '../../stamp/schedule.js';
import { addPerson, allStaff, exemptPerson, includePerson, issuePin, personById, setActive, unlockPerson } from '../../stamp/staff.js';
import { openStampStore, type StampStore } from '../../stamp/store.js';
import { loadEmployerConfig } from '../../config.js';
import { openInBrowser } from '../open.js';
import type { DesktopPaths } from '../paths.js';
import { qrSvg } from '../qr.js';
import { backupAndRecord, backupCandidates } from '../backup.js';
import { readDesktopState, writeDesktopState } from '../state.js';
import type { Updater } from '../../update/updater.js';
import { newer } from '../../update/release.js';
import { readRollback } from '../../update/versions.js';
import { RELEASES_PAGE, VERSION } from '../../version.js';
import { EASY_SERVER, namelessSender, newEasyTopic } from '../../stamp/notify.js';
// `Html` is markup this program built itself — here, the QR code's SVG (qr.ts); everything else is escaped.
import { Html, csrfField, html, note, page } from './html.js';
import { accountantPage } from './accountant-page.js';
import { calendarPage } from './calendar-page.js';
import type { OwnerPage } from './server.js';
import { missingProofsPanel, ownerOverview } from './overview.js';
import { readOverviewMaintenance } from './overview-maintenance.js';
import { settingsPage } from './settings.js';

/**
 * THE OWNER'S PAGES — what `ergani admin` does, as pages, on this computer's own store. ⛔ None stamps a card: the
 * owner decides who stamps; only the employee stamps, with their own PIN, at the staff page (docs/RULES.md rule 1).
 * Each action is the same function the command line calls; a refusal comes back as a red line on the same page.
 */
const OWNER = 'ο εργοδότης (από τις σελίδες του)';
const REASONS: ReadonlyArray<readonly [string, string]> = [
  ['001', 'Πρόβλημα στην ηλεκτροδότηση / τις τηλεπικοινωνίες'],
  ['002', 'Πρόβλημα στα συστήματα του εργοδότη'],
  ['003', 'Πρόβλημα σύνδεσης με το ΠΣ ΕΡΓΑΝΗ'],
];

export interface PagesContext {
  paths: DesktopPaths;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  /** Since when ΕΡΓΑΝΗ has not answered (10 minutes or more), from the stamping service (stamp/reach.ts). */
  erganiSilentSince: (nowMs: number) => number | undefined;
  /** Why the staff page is not open now (the listen error's code), from the stamping service; undefined when it is. */
  staffPageProblem?: () => string | undefined;
  /** Present when the launcher runs the program (the installed program); absent otherwise — no updates then. */
  updater?: Updater | undefined;
  /** Open an employee's records folder with the system's file browser (not under `--no-open`). */
  openFolders?: boolean;
  /** Apply changed settings after the current send finishes. */
  reloadSettings?: () => Promise<void>;
}

const when = (iso: string) => new Date(iso).toLocaleString('el-GR', { timeZone: 'Europe/Athens' });

/**
 * What the «Ενημερώσεις» page says when a release comes as an installer here (Windows, update/updater.ts): a version on
 * a new Node.js line — instead of the button, which cannot install it — or the Node.js fixes a newer installer brings.
 */
export function installerNote(u: Updater): Html | undefined {
  const available = u.available();
  const get = html`Κατεβάστε το από <a href="${RELEASES_PAGE}">τη σελίδα των εκδόσεων</a> και τρέξτε το (θέλει τον κωδικό διαχειριστή του υπολογιστή)· τα δεδομένα σας μένουν όπως είναι.`;
  if (available !== undefined && u.needsInstaller()) {
    return note('warn', html`Νέα έκδοση ${available}: φέρνει νέα σειρά Node.js, γι’ αυτό στα Windows εγκαθίσταται με το νέο πρόγραμμα εγκατάστασης, όχι από εδώ. ${get}`);
  }
  const node = u.nodeByInstaller();
  if (node === undefined) return undefined;
  return note('warn', html`Το πρόγραμμα τρέχει στο Node.js ${u.installedNode}. Το νεότερο πρόγραμμα εγκατάστασης φέρνει το Node.js ${node}, με τις διορθώσεις ασφαλείας του — στα Windows αυτό δεν έρχεται με τις ενημερώσεις. ${get}`);
}

export function ownerPages(c: PagesContext): ReadonlyMap<string, OwnerPage> {
  let ergani = loadEmployerConfig(c.env);
  let settings = loadStampSettings(c.env);
  let codes = ergani.branches.map((b) => b.branchCode);
  const db: StampStore = openStampStore(c.paths.stampDb, { name: settings.instance, realm: ergani.erganiRealm, employerAfm: ergani.employerAfm }, codes);
  const heading = (code: string) => branchHeading(settings, code);
  let many = codes.length > 1;
  let pageAddress = `http://${settings.listenHost}:${settings.port}`;
  const fail = (error: unknown) => note('bad', `Δεν έγινε: ${error instanceof Error ? error.message : String(error)}`);
  const done = (title: string, csrf: string, body: Html) => ({ body: page(title, body, { csrf }) });

  /** A switch undone by itself, while this program has not moved past the version that failed. */
  const rolledBack = () => {
    const back = readRollback(c.paths.versions);
    if (back === undefined || c.updater === undefined || !newer(back.failed, VERSION)) return html``;
    return note('bad', `Η ενημέρωση στην έκδοση ${back.failed} δεν ξεκίνησε σωστά (${back.why}), και το πρόγραμμα γύρισε μόνο του στην έκδοση ${back.back} στις ${when(back.atIso)}. Δεν χάθηκε τίποτα. Δεν θα ξαναδοκιμαστεί μόνη της.`);
  };

  const home: OwnerPage = ({ csrf }) => {
    const now = c.now();
    const state = readDesktopState(c.paths.desktop);
    const pageProblem = c.staffPageProblem?.();
    const available = c.updater?.available();
    const needsInstaller = c.updater?.needsInstaller() === true;
    const byItself = state?.nightUpdates === true && readRollback(c.paths.versions)?.failed !== available && !needsInstaller;
    return done('Αρχική', csrf, html`
${ergani.erganiRealm === 'production' ? html`` : note('warn', html`Ρυθμισμένο για το <strong>${ergani.erganiRealm === 'trial' ? 'δοκιμαστικό' : 'δοκιμαστικό (τοπικό)'}</strong> περιβάλλον: ό,τι δηλώνεται δεν είναι πραγματική δήλωση.`)}
${pageProblem === undefined ? html`` : note('bad', `Η σελίδα των εργαζομένων δεν ανοίγει στο ${pageAddress}: ${pageProblem === 'EADDRNOTAVAIL' ? 'αυτή η διεύθυνση δεν υπάρχει τώρα σε αυτόν τον υπολογιστή (δεν έχει συνδεθεί ακόμη στο δίκτυο του ιατρείου, ή ο router του έδωσε άλλη)' : pageProblem === 'EADDRINUSE' ? 'τη θύρα την κρατά ήδη άλλο πρόγραμμα' : pageProblem}. Ξαναδοκιμάζει μόνο του κάθε μισό λεπτό· οι κάρτες που περιμένουν στέλνονται κανονικά.`)}
${ownerOverview({ db, nowMs: now, silentSince: c.erganiSilentSince(now), heading, maintenance: readOverviewMaintenance({ paths: c.paths, nowMs: now, archiveFrom: c.env['ARCHIVE_FROM'] ?? '', branches: codes, employerAfm: ergani.employerAfm, realm: ergani.erganiRealm }) })}
${rolledBack()}
${available === undefined ? html`` : note('warn', html`Νέα έκδοση ${available}: ${needsInstaller ? 'θέλει το νέο πρόγραμμα εγκατάστασης — ' : byItself ? 'εγκαθίσταται μόνη της τη νύχτα, ή ' : ''}<a href="/updates">Ενημερώσεις</a>.`)}
<p>Η σελίδα των εργαζομένων: <strong>${pageAddress}</strong>${settings.listenHost === '127.0.0.1' ? ' (μόνο σε αυτόν τον υπολογιστή)' : ''}.</p>`);
  };

  const staff: OwnerPage = async ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      const afm = (form.get('afm') ?? '').trim();
      try {
        switch (form.get('do')) {
          case 'add': {
            const exempt = (form.get('exempt') ?? '').trim();
            const added = await addPerson(
              db,
              { afm, surname: form.get('surname') ?? '', firstName: form.get('first') ?? '', displayName: (form.get('display') ?? '').trim() || undefined, exemptReason: exempt || undefined },
              OWNER,
              c.now(),
            );
            const person = personById(db, added.id);
            message = added.oneTimePin === undefined
              ? note('ok', `Προστέθηκε «${person?.displayName}» — δεν χτυπά κάρτα (εξαίρεση: ${exempt}).`)
              : note('ok', html`Προστέθηκε «${person?.displayName}». Προσωρινός κωδικός — δώστε τον αυτοπροσώπως· στη σελίδα θα διαλέξει δικό του:<br><span class="pin">${added.oneTimePin}</span>`);
            break;
          }
          case 'pin':
            message = note('ok', html`Νέος προσωρινός κωδικός — δώστε τον αυτοπροσώπως:<br><span class="pin">${await issuePin(db, afm, OWNER, c.now())}</span>`);
            break;
          case 'unlock':
            unlockPerson(db, afm, OWNER, c.now());
            message = note('ok', 'Ξεκλειδώθηκε.');
            break;
          case 'exempt':
            await exemptPerson(db, afm, form.get('reason') ?? '', OWNER, c.now());
            message = note('ok', 'Δεν χτυπά πια κάρτα· ο λόγος καταγράφηκε.');
            break;
          case 'include': {
            const pin = await includePerson(db, afm, OWNER, c.now());
            message = note('ok', pin === undefined ? 'Χτυπά ξανά κάρτα.' : html`Χτυπά ξανά κάρτα. Προσωρινός κωδικός:<br><span class="pin">${pin}</span>`);
            break;
          }
          case 'deactivate':
          case 'reactivate':
            setActive(db, afm, form.get('do') === 'reactivate', OWNER, c.now());
            message = note('ok', form.get('do') === 'reactivate' ? 'Ενεργός ξανά.' : 'Απενεργοποιήθηκε — μένει στο αρχείο, δεν φαίνεται πια στη σελίδα.');
            break;
          default:
            message = note('bad', 'Άγνωστη ενέργεια.');
        }
      } catch (error) {
        message = fail(error);
      }
    }
    const action = (afm: string, todo: string, label: string, extra: Html = html``) =>
      html`<form class="inline" method="post" action="/staff">${csrfField(csrf)}<input type="hidden" name="afm" value="${afm}"><input type="hidden" name="do" value="${todo}">${extra}<button class="secondary">${label}</button></form> `;
    const rows = allStaff(db).map((p) => html`<tr><td>${p.displayName}<br><span class="hint">${p.surname} ${p.firstName} · ${p.afm}</span></td>
<td>${!p.active ? 'ανενεργός' : p.mustStamp ? (p.lockedUntilMs !== undefined && p.lockedUntilMs > c.now() ? 'κλειδωμένος (λάθος κωδικοί)' : p.pinIsTemporary ? 'χτυπά — δεν έχει διαλέξει κωδικό' : 'χτυπά') : `δεν χτυπά: ${p.exemptReason ?? ''}`}</td>
<td>${p.active ? html`${p.mustStamp ? action(p.afm, 'pin', 'Νέος κωδικός') : html``}${p.lockedUntilMs !== undefined && p.lockedUntilMs > c.now() ? action(p.afm, 'unlock', 'Ξεκλείδωμα') : html``}${p.mustStamp ? action(p.afm, 'exempt', 'Εξαίρεση', html`<input type="text" name="reason" placeholder="λόγος, π.χ. οδοντίατρος">`) : action(p.afm, 'include', 'Να χτυπά')}${action(p.afm, 'deactivate', 'Απενεργοποίηση')}` : action(p.afm, 'reactivate', 'Ενεργοποίηση')}</td></tr>`);
    return done('Προσωπικό', csrf, html`${message}
<p class="hint">Ο εργοδότης ορίζει ποιος χτυπά· μόνο ο ίδιος ο εργαζόμενος χτυπά, με τον δικό του κωδικό, στη σελίδα των εργαζομένων.</p>
<table><tr><th>Όνομα</th><th>Κατάσταση</th><th></th></tr>${rows}</table>
<form method="post" action="/staff"><fieldset><legend>Νέος εργαζόμενος</legend>${csrfField(csrf)}<input type="hidden" name="do" value="add">
<label for="afm">ΑΦΜ</label><input type="text" id="afm" name="afm" inputmode="numeric">
<label for="surname">Επώνυμο (όπως στην ΕΡΓΑΝΗ)</label><input type="text" id="surname" name="surname">
<label for="first">Όνομα (όπως στην ΕΡΓΑΝΗ)</label><input type="text" id="first" name="first">
<label for="display">Όνομα στη σελίδα (προαιρετικό)</label><input type="text" id="display" name="display">
<label for="exempt">Αν ΔΕΝ χτυπά κάρτα: ο λόγος (π.χ. «οδοντίατρος») — αλλιώς κενό</label><input type="text" id="exempt" name="exempt">
<p><button>Προσθήκη</button></p></fieldset></form>`);
  };

  const devices: OwnerPage = ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      try {
        if (form.get('do') === 'revoke') {
          revokeDevice(db, Number(form.get('id')), c.now());
          message = note('ok', 'Η συσκευή δεν δείχνει πια τη σελίδα.');
        } else {
          const branch = many ? (form.get('branch') ?? '') : codes[0]!;
          if (!codes.includes(branch)) throw new Error('διαλέξτε παράρτημα');
          const label = (form.get('label') ?? '').trim() || 'Συσκευή';
          const link = `${pageAddress}/enroll/${createEnrollment(db, branch, label, c.now())}`;
          message = html`${note('ok', html`Ανοίξτε τον σύνδεσμο <strong>μία φορά</strong>, μέσα σε 30 λεπτά, <strong>στη συσκευή</strong> που θα δείχνει τη σελίδα «${heading(branch)}» — με την κάμερα του κινητού, ή πληκτρολογώντας τον:`)}
<p class="qr">${new Html(qrSvg(link))}</p><p><code>${link}</code></p>
${settings.listenHost === '127.0.0.1' ? note('warn', 'Η σελίδα ακούει μόνο σε αυτόν τον υπολογιστή: ένα κινητό δεν τη βρίσκει. Για κινητά, κάντε ξανά τη ρύθμιση με τη διεύθυνση του Wi-Fi.') : html``}`;
        }
      } catch (error) {
        message = fail(error);
      }
    }
    const list = allDevices(db).filter((d) => d.revokedAt === undefined);
    return done('Συσκευές', csrf, html`${message}
<p>Μόνο οι συσκευές εδώ βλέπουν τη σελίδα των εργαζομένων.</p>
<table><tr><th>Συσκευή</th>${many ? html`<th>Παράρτημα</th>` : html``}<th>Από</th><th></th></tr>
${list.map((d) => html`<tr><td>${d.label}</td>${many ? html`<td>${heading(d.branch)}</td>` : html``}<td>${d.enrolledAt.slice(0, 10)}</td><td><form class="inline" method="post" action="/devices">${csrfField(csrf)}<input type="hidden" name="do" value="revoke"><input type="hidden" name="id" value="${d.id}"><button class="secondary">Αφαίρεση</button></form></td></tr>`)}</table>
<form method="post" action="/devices"><fieldset><legend>Νέα συσκευή — ο υπολογιστής της υποδοχής ή ένα κινητό</legend>${csrfField(csrf)}<input type="hidden" name="do" value="enroll">
${many ? html`<label for="branch">Παράρτημα</label><select id="branch" name="branch">${codes.map((code) => html`<option value="${code}">${heading(code)}</option>`)}</select>` : html``}
<label for="label">Ποια συσκευή (π.χ. «Υποδοχή», «Κινητό 1»)</label><input type="text" id="label" name="label">
<p><button>Σύνδεσμος και QR</button></p></fieldset></form>`);
  };

  const queue: OwnerPage = ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      try {
        const choice = form.get('choice') ?? '';
        const input = choice === 'covered' ? ({ kind: 'covered' } as const) : ({ kind: 'file_late', fAitiologia: WorkCardDelayReason.parse(choice) } as const);
        decide(db, Number(form.get('card')), input, { employeeId: undefined, label: OWNER, deviceId: undefined }, c.now());
        message = note('ok', choice === 'covered' ? 'Καταγράφηκε: δεν στέλνεται από εδώ.' : 'Καταγράφηκε: θα σταλεί εκπρόθεσμα, με αυτή την αιτία.');
      } catch (error) {
        message = fail(error);
      }
    }
    const now = c.now();
    const waiting = openPunches(db).filter((p) => stateOfPunch(db, p, now).kind === 'needs-human');
    return done('Εκκρεμότητες', csrf, html`${message}
${waiting.length === 0 ? note('ok', 'Καμία κάρτα δεν περιμένει απόφαση.') : html``}
${waiting.map((p) => html`<form method="post" action="/queue"><fieldset><legend>${personById(db, p.employeeId)?.displayName ?? '—'} — ${p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ'} ${athensTime(p.eventMs).date} ${athensTime(p.eventMs).time.slice(0, 5)}${many ? ` — ${heading(p.branch)}` : ''}</legend>${csrfField(csrf)}<input type="hidden" name="card" value="${p.id}">
${REASONS.map(([code, text]) => html`<p class="check"><input type="radio" id="c${p.id}_${code}" name="choice" value="${code}"><label for="c${p.id}_${code}">Να σταλεί εκπρόθεσμα — ${text}</label></p>`)}
<p class="check"><input type="radio" id="c${p.id}_cov" name="choice" value="covered"><label for="c${p.id}_cov">Καλύφθηκε αλλιώς (π.χ. CardScanner) — να μη σταλεί από εδώ</label></p>
<p><button>Απόφαση</button></p></fieldset></form>`)}
${missingProofsPanel(db, now, heading)}
<p class="hint">Αν μια κάρτα δεν στάλθηκε μέσα σε 15 λεπτά, ο εργοδότης ειδοποιεί την Επιθεώρηση Εργασίας όταν αρχίζει το πρόβλημα και όταν τελειώνει.</p>`);
  };

  const days: OwnerPage = ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      try {
        const quiet = form.get('do') !== 'unquiet';
        markQuietDay(db, form.get('date') ?? '', quiet, (form.get('reason') ?? '').trim(), OWNER, c.now());
        message = note('ok', quiet ? 'Κλειστή μέρα: καμία ειδοποίηση «δεν χτύπησε».' : 'Η μέρα δεν είναι πια κλειστή.');
      } catch (error) {
        message = fail(error);
      }
    }
    return done('Κλειστές μέρες', csrf, html`${message}
<p>Μια κλειστή μέρα (αργία, άδεια του ιατρείου): καμία ειδοποίηση «δεν χτύπησε ΕΝΑΡΞΗ», σε κανένα παράρτημα. Κρατιούνται και τα δύο: το σημάδι και η άρση του.</p>
<form method="post" action="/days"><fieldset>${csrfField(csrf)}
<label for="date">Ημερομηνία</label><input type="date" id="date" name="date">
<label for="reason">Λόγος (π.χ. «28η Οκτωβρίου»)</label><input type="text" id="reason" name="reason">
<p><button name="do" value="quiet">Κλειστή</button> <button class="secondary" name="do" value="unquiet">Άρση</button></p></fieldset></form>`);
  };

  /** Output of the command line's own code, for the pages that reuse it whole (the check, a person's records). */
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    await adminCommand(argv, c.env, { now: c.now, out: (line) => lines.push(line) });
    return lines;
  };

  const records: OwnerPage = async ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      try {
        const afm = (form.get('afm') ?? '').trim();
        const argv = ['history', '--afm', afm, '--out', c.paths.exports];
        const from = (form.get('from') ?? '').trim();
        const to = (form.get('to') ?? '').trim();
        if (from !== '') argv.push('--from', from);
        if (to !== '') argv.push('--to', to);
        // ⛔ Exactly the folder THIS request made (admin.ts makes a new one per request) — never «the newest by name»,
        // which can be another person's: the owner hands this folder to one person.
        const before = new Set(existsSync(c.paths.exports) ? readdirSync(c.paths.exports) : []);
        await run(argv);
        const made = readdirSync(c.paths.exports).filter((name) => !before.has(name));
        if (made.length !== 1) throw new Error('δεν βρέθηκε ο φάκελος αυτής της αίτησης — δοκιμάστε ξανά');
        const folder = join(c.paths.exports, made[0]!);
        if (c.openFolders !== false) openInBrowser(folder, c.log);
        message = note('ok', html`Γράφτηκαν μια σελίδα (εκτυπώνεται) και ένα αρχείο λογιστικού φύλλου, μόνο με τις δικές του κάρτες, στον φάκελο:<br><code>${folder}</code><br>Ο φάκελος άνοιξε. Δώστε τα <strong>μόνο σε εκείνον</strong>, και σβήστε μετά τα αντίγραφα.`);
      } catch (error) {
        message = fail(error);
      }
    }
    return done('Αρχείο εργαζομένου', csrf, html`${message}
<p>Κάθε εργαζόμενος έχει δικαίωμα να δει τις δικές του καταγραφές.</p>
<form method="post" action="/records"><fieldset>${csrfField(csrf)}
<label for="afm">Εργαζόμενος</label><select id="afm" name="afm">${allStaff(db).map((p) => html`<option value="${p.afm}">${p.displayName} (${p.surname} ${p.firstName})</option>`)}</select>
<label for="from">Από (κενό: πέντε χρόνια πίσω)</label><input type="date" id="from" name="from">
<label for="to">Έως (κενό: σήμερα)</label><input type="date" id="to" name="to">
<p><button>Δημιουργία</button></p></fieldset></form>`);
  };

  const check: OwnerPage = async ({ csrf }) => {
    try {
      const lines = await run(['check']);
      return done('Έλεγχος σύνδεσης με την ΕΡΓΑΝΗ', csrf, html`<p class="hint">Μόνο ανάγνωση — τίποτα δεν δηλώθηκε.</p><pre>${lines.join('\n')}</pre>`);
    } catch (error) {
      return done('Έλεγχος σύνδεσης με την ΕΡΓΑΝΗ', csrf, fail(error));
    }
  };

  const backup: OwnerPage = ({ method, form, csrf }) => {
    let message = html``;
    if (method === 'POST') {
      const state = readDesktopState(c.paths.desktop)!;
      if (form.get('do') === 'folder') {
        const folder = (form.get('custom') ?? '').trim() || (form.get('folder') ?? '').trim();
        if (folder === '') message = note('bad', 'Διαλέξτε ή γράψτε έναν φάκελο.');
        else {
          writeDesktopState(c.paths.desktop, { ...state, backupFolder: folder });
          message = note('ok', html`Τα αντίγραφα πηγαίνουν στο <code>${folder}</code>.`);
        }
      }
      if (form.get('do') === 'now' || (form.get('do') === 'folder' && readDesktopState(c.paths.desktop)?.backupFolder !== undefined)) {
        const result = backupAndRecord(c.paths, c.now(), c.log);
        message = html`${message}${result.ok ? note('ok', html`Το αντίγραφο γράφτηκε στο <code>${result.folder}</code>.`) : note('bad', `Το αντίγραφο απέτυχε: ${result.problem}`)}`;
      }
    }
    const state = readDesktopState(c.paths.desktop);
    const chosen = state?.backupFolder;
    return done('Αντίγραφα ασφαλείας', csrf, html`${message}
<p>Κάθε μέρα, μόνο του, ένα πλήρες αντίγραφο του αρχείου (κάρτες, προσωπικό, μηνιαίο αρχείο) πηγαίνει σε έναν φάκελο που
διαλέγετε: ένα <strong>USB</strong> που μένει συνδεδεμένο, ή τον φάκελο του <strong>Dropbox</strong>. Κρατιούνται τα
τελευταία 30. Το αντίγραφο έχει ΑΦΜ και ώρες εργασίας: φυλάξτε το όπως το ίδιο το αρχείο.</p>
<p>Φάκελος τώρα: ${chosen === undefined ? html`<strong>κανένας</strong>` : html`<code>${chosen}</code>`}</p>
<form method="post" action="/backup"><fieldset><legend>Πού να πηγαίνουν</legend>${csrfField(csrf)}<input type="hidden" name="do" value="folder">
${backupCandidates().map((folder) => html`<p class="check"><input type="radio" id="f_${folder}" name="folder" value="${folder}"${folder === chosen ? html` checked` : html``}><label for="f_${folder}">${folder}</label></p>`)}
<label for="custom">Ή γράψτε τον φάκελο</label><input type="text" id="custom" name="custom">
<p><button>Αποθήκευση και αντίγραφο τώρα</button></p></fieldset></form>
${chosen === undefined ? html`` : html`<form method="post" action="/backup">${csrfField(csrf)}<input type="hidden" name="do" value="now"><p><button class="secondary">Αντίγραφο τώρα</button></p></form>`}
<p class="hint">Επαναφορά: κλείστε το πρόγραμμα, και αντιγράψτε τα <code>stamp.sqlite</code> και <code>records.sqlite</code>
ενός αντιγράφου στους φακέλους <code>stamp</code> και <code>records</code> του <code>${c.paths.root}</code>.</p>`);
  };

  const updates: OwnerPage = async ({ method, form, csrf }) => {
    const u = c.updater;
    if (u === undefined) {
      return done('Ενημερώσεις', csrf, html`<p>Έκδοση ${VERSION}.</p><p>Οι ενημερώσεις γίνονται μόνο στο εγκατεστημένο πρόγραμμα.</p>`);
    }
    let message = html``;
    if (method === 'POST') {
      const state = readDesktopState(c.paths.desktop)!;
      switch (form.get('do')) {
        case 'night':
          writeDesktopState(c.paths.desktop, { ...state, nightUpdates: form.get('night') === 'on' });
          message = note('ok', form.get('night') === 'on' ? 'Οι ενημερώσεις εγκαθίστανται μόνες τους τη νύχτα.' : 'Οι ενημερώσεις ΔΕΝ εγκαθίστανται πια μόνες τους· μόνο με το κουμπί.');
          break;
        case 'check': {
          const found = await u.check();
          message = found.ok ? note('ok', found.available === undefined ? 'Έχετε την νεότερη έκδοση.' : `Υπάρχει νέα έκδοση: ${found.available}.`) : note('bad', `Ο έλεγχος απέτυχε: ${found.problem ?? ''}`);
          break;
        }
        case 'install':
          // The switch ends this program; the answer goes out first.
          setTimeout(() => {
            void u.install().then((result) => {
              if (result !== undefined) c.log(`update by the button did not happen — ${result.problem}`);
            });
          }, 500);
          return done('Ενημερώσεις', csrf, note('ok', 'Η ενημέρωση ξεκίνησε: κατεβαίνει, ελέγχεται η υπογραφή της, και το πρόγραμμα ξεκινά ξανά μόνο του σε ένα-δύο λεπτά. Ανανεώστε τότε τη σελίδα και συνδεθείτε ξανά. Αν δεν έγινε, εδώ θα γράφει γιατί.'));
        default:
          message = note('bad', 'Άγνωστη ενέργεια.');
      }
    }
    const state = readDesktopState(c.paths.desktop);
    const record = state?.update;
    const available = u.available();
    const night = state?.nightUpdates ?? true;
    return done('Ενημερώσεις', csrf, html`${message}
<p>Έκδοση: <strong>${VERSION}</strong>.</p>
${rolledBack()}
${record === undefined ? html`<p>Δεν έχει γίνει ακόμη έλεγχος για νέα έκδοση (γίνεται μία φορά την ημέρα).</p>` : record.ok ? html`<p>Τελευταίος έλεγχος: ${when(record.checkedIso)}.</p>` : note('warn', `Ο τελευταίος έλεγχος (${when(record.checkedIso)}) απέτυχε: ${record.problem ?? ''}`)}
${record?.installProblem === undefined || available === undefined ? html`` : note('warn', `Η τελευταία προσπάθεια ενημέρωσης (${when(record.installProblem.atIso)}) δεν έγινε: ${record.installProblem.problem}`)}
${installerNote(u) ?? html``}
${available === undefined || u.needsInstaller() ? html`` : html`<form method="post" action="/updates"><fieldset><legend>Νέα έκδοση ${available}</legend>${csrfField(csrf)}<input type="hidden" name="do" value="install">
<p>Η σελίδα των εργαζομένων σταματά για ένα-δύο λεπτά. Αν η νέα έκδοση δεν ξεκινήσει σωστά, το πρόγραμμα γυρίζει μόνο του στην τωρινή.</p>
<p><button>Ενημέρωση τώρα</button></p></fieldset></form>`}
<form method="post" action="/updates">${csrfField(csrf)}<input type="hidden" name="do" value="check"><p><button class="secondary">Έλεγχος τώρα</button></p></form>
<form method="post" action="/updates"><fieldset><legend>Αυτόματα τη νύχτα</legend>${csrfField(csrf)}<input type="hidden" name="do" value="night">
<p class="check"><input type="checkbox" id="night" name="night" value="on"${night ? html` checked` : html``}><label for="night">Να εγκαθίστανται μόνες τους, 02:00–05:00, όταν κανείς δεν έχει χτυπήσει την τελευταία ώρα και καμία κάρτα δεν είναι καθ’ οδόν.</label></p>
<p><button>Αποθήκευση</button></p></fieldset></form>
<p class="hint">Εγκαθίστανται μόνο εκδόσεις υπογεγραμμένες με το κλειδί του έργου. Ο έλεγχος είναι μία ερώτηση την ημέρα στο GitHub για τη νεότερη έκδοση· τίποτα άλλο δεν στέλνεται, σε κανέναν. Αν ο υπολογιστής είναι κλειστός τη νύχτα, πατήστε «Ενημέρωση τώρα» όταν το βολεύει.</p>`);
  };

  /** The easy phone alerts: nameless pushes to a random ntfy.sh topic (stamp/notify.ts says why that is safe). */
  const alerts: OwnerPage = async ({ method, form, csrf }) => {
    let message = html``;
    const state = readDesktopState(c.paths.desktop)!;
    if (method === 'POST') {
      switch (form.get('do')) {
        case 'on':
        case 'new':
          // «Άνοιγμα» keeps a topic already there (an old tab, a form sent twice): only «Νέο θέμα» cuts the phones off.
          if (form.get('do') === 'new' || state.alerts === undefined) writeDesktopState(c.paths.desktop, { ...state, alerts: { topic: newEasyTopic() } });
          message = note('ok', form.get('do') === 'new' ? 'Νέο θέμα: σκανάρετε ξανά το QR σε κάθε κινητό· το παλιό δεν λαμβάνει πια τίποτα.' : 'Οι ειδοποιήσεις άνοιξαν. Σκανάρετε το QR με το κινητό σας.');
          break;
        case 'off': {
          const { alerts: _off, ...rest } = state;
          writeDesktopState(c.paths.desktop, rest);
          message = note('ok', 'Οι ειδοποιήσεις έκλεισαν.');
          break;
        }
        case 'test': {
          const topic = state.alerts?.topic;
          try {
            if (topic === undefined) throw new Error('οι ειδοποιήσεις είναι κλειστές');
            await namelessSender(topic)({ title: '', message: '', priority: 3 }, 'test');
            message = note('ok', 'Η ΔΟΚΙΜΗ στάλθηκε — πρέπει να φτάσει στο κινητό σε λίγα δευτερόλεπτα.');
          } catch (error) {
            message = fail(error);
          }
          break;
        }
        default:
          message = note('bad', 'Άγνωστη ενέργεια.');
      }
    }
    const topic = readDesktopState(c.paths.desktop)?.alerts?.topic;
    const button = (todo: string, label: string, secondary = true) =>
      html`<form class="inline" method="post" action="/alerts">${csrfField(csrf)}<input type="hidden" name="do" value="${todo}"><button${secondary ? html` class="secondary"` : html``}>${label}</button></form> `;
    if (topic === undefined) {
      return done('Ειδοποιήσεις', csrf, html`${message}
<p>Όταν μια κάρτα δεν στάλθηκε στην ΕΡΓΑΝΗ ή κάποιος δεν χτύπησε, ένα σύντομο μήνυμα στο κινητό σας — <strong>χωρίς ονόματα</strong>:
«…δείτε τη σελίδα στο ιατρείο». Δωρεάν, με την εφαρμογή <strong>ntfy</strong> (Android, iPhone), μέσω της δημόσιας υπηρεσίας ntfy.sh.</p>
<p>${button('on', 'Άνοιγμα', false)}</p>`);
    }
    const link = `${EASY_SERVER}/${topic}`;
    return done('Ειδοποιήσεις', csrf, html`${message}
${note('ok', 'Οι ειδοποιήσεις είναι ανοιχτές — χωρίς ονόματα.')}
<ol>
<li>Στο κινητό: εγκαταστήστε τη δωρεάν εφαρμογή <strong>ntfy</strong>.</li>
<li>Σκανάρετε αυτό το QR με την κάμερα (ή, στην εφαρμογή, «+» και το θέμα από κάτω).</li>
<li>Πατήστε «ΔΟΚΙΜΗ»: το μήνυμα πρέπει να φτάσει σε λίγα δευτερόλεπτα.</li>
</ol>
<p class="qr">${new Html(qrSvg(link))}</p><p>Θέμα: <code>${topic}</code></p>
<p>${button('test', 'ΔΟΚΙΜΗ', false)}${button('new', 'Νέο θέμα')}${button('off', 'Κλείσιμο')}</p>
<p class="hint">Τα μηνύματα δεν έχουν ονόματα, ΑΦΜ ή ώρες — μόνο «κάτι θέλει την προσοχή σας». Όποιος μάθει το θέμα μπορεί να τα
διαβάσει· γι' αυτό είναι μακρύ και τυχαίο, και «Νέο θέμα» το αλλάζει. Τα ονόματα μένουν στη σελίδα του ιατρείου.</p>`);
  };

  const pages = new Map<string, OwnerPage>([
    ['/settings', settingsPage(c, db)],
    ['/', home],
    ['/alerts', alerts],
    ['/updates', updates],
    ['/staff', staff],
    ['/devices', devices],
    ['/queue', queue],
    ['/days', days],
    ['/calendar', (request) => calendarPage(db, settings.branches, c.now)(request)],
    ['/records', records],
    ['/accountant', accountantPage({ db, paths: c.paths, now: c.now, branchName: heading, openFolders: c.openFolders !== false, log: c.log })],
    ['/check', check],
    ['/backup', backup],
  ]);
  // Keep the same store connection; headings and CLI actions use the settings currently serving the staff.
  return new Map([...pages].map(([path, handler]) => [path, (request) => {
    ergani = loadEmployerConfig(c.env);
    settings = loadStampSettings(c.env);
    codes = ergani.branches.map((b) => b.branchCode);
    many = codes.length > 1;
    pageAddress = `http://${settings.listenHost}:${settings.port}`;
    return handler(request);
  }]));
}

