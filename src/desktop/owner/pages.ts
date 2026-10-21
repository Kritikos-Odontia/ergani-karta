// SPDX-License-Identifier: EUPL-1.2
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkCardDelayReason } from '../../ergani/types.js';
import { adminCommand } from '../../stamp/admin.js';
import { athensTime } from '../../stamp/athens.js';
import { branchHeading, loadStampSettings } from '../../stamp/config.js';
import { allDevices, createEnrollment, revokeDevice } from '../../stamp/devices.js';
import { cardsMissingProof, decide, openPunches, stateOfPunch } from '../../stamp/outbox.js';
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
import { VERSION } from '../../version.js';
// `Html` is markup this program built itself — here, the QR code's SVG (qr.ts); everything else is escaped.
import { Html, csrfField, html, note, page } from './html.js';
import type { OwnerPage } from './server.js';

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
  /** Present when the launcher runs the program (the installed program); absent otherwise — no updates then. */
  updater?: Updater | undefined;
}

const when = (iso: string) => new Date(iso).toLocaleString('el-GR', { timeZone: 'Europe/Athens' });

export function ownerPages(c: PagesContext): ReadonlyMap<string, OwnerPage> {
  const ergani = loadEmployerConfig(c.env);
  const settings = loadStampSettings(c.env);
  const codes = ergani.branches.map((b) => b.branchCode);
  const db: StampStore = openStampStore(c.paths.stampDb, { name: settings.instance, realm: ergani.erganiRealm, employerAfm: ergani.employerAfm }, codes);
  const heading = (code: string) => branchHeading(settings, code);
  const many = codes.length > 1;
  const pageAddress = `http://${settings.listenHost}:${settings.port}`;
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
    const waiting = openPunches(db).filter((p) => stateOfPunch(db, p, now).kind === 'needs-human').length;
    const state = readDesktopState(c.paths.desktop);
    const backup = state?.lastBackup;
    const silent = c.erganiSilentSince(now);
    return done('Αρχική', csrf, html`
${ergani.erganiRealm === 'production' ? html`` : note('warn', html`Ρυθμισμένο για το <strong>${ergani.erganiRealm === 'trial' ? 'δοκιμαστικό' : 'δοκιμαστικό (τοπικό)'}</strong> περιβάλλον: ό,τι δηλώνεται δεν είναι πραγματική δήλωση.`)}
${silent === undefined ? html`` : note('bad', `Ο υπολογιστής δεν φτάνει την ΕΡΓΑΝΗ από τις ${athensTime(silent).time.slice(0, 5)} (${athensTime(silent).date}). Οι κάρτες κρατιούνται και στέλνονται μόλις επανέλθει· αν μια κάρτα περάσει τα 15 λεπτά, ειδοποιήστε την Επιθεώρηση Εργασίας όταν αρχίζει και όταν τελειώνει το πρόβλημα.`)}
${waiting > 0 ? note('bad', html`${waiting} κάρτα/-ες χρειάζονται απόφαση: <a href="/queue">Εκκρεμότητες</a>.`) : note('ok', 'Καμία κάρτα δεν περιμένει απόφαση.')}
${backup === undefined ? note('warn', html`Δεν έχει γίνει ακόμη αντίγραφο ασφαλείας: <a href="/backup">Αντίγραφα</a>.`) : backup.ok ? note('ok', `Τελευταίο αντίγραφο: ${when(backup.atIso)}.`) : note('bad', `Το τελευταίο αντίγραφο απέτυχε: ${backup.problem ?? ''}`)}
${rolledBack()}
${state?.update?.available === undefined || c.updater === undefined ? html`` : note('warn', html`Νέα έκδοση ${state.update.available}: ${state.nightUpdates ? 'εγκαθίσταται μόνη της τη νύχτα, ή ' : ''}<a href="/updates">Ενημερώσεις</a>.`)}
<p>Η σελίδα των εργαζομένων: <strong>${pageAddress}</strong>${settings.listenHost === '127.0.0.1' ? ' (μόνο σε αυτόν τον υπολογιστή)' : ''}.</p>
<p><a href="/check">Έλεγχος σύνδεσης με την ΕΡΓΑΝΗ</a> — μόνο ανάγνωση: για κάθε παράρτημα, αν ο χρήστης του συνδέεται και αν του επιτρέπεται η δήλωση κάρτας.</p>`);
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
    const missing = cardsMissingProof(db);
    return done('Εκκρεμότητες', csrf, html`${message}
${waiting.length === 0 ? note('ok', 'Καμία κάρτα δεν περιμένει απόφαση.') : html``}
${waiting.map((p) => html`<form method="post" action="/queue"><fieldset><legend>${personById(db, p.employeeId)?.displayName ?? '—'} — ${p.fType === '0' ? 'ΕΝΑΡΞΗ' : 'ΛΗΞΗ'} ${athensTime(p.eventMs).date} ${athensTime(p.eventMs).time.slice(0, 5)}${many ? ` — ${heading(p.branch)}` : ''}</legend>${csrfField(csrf)}<input type="hidden" name="card" value="${p.id}">
${REASONS.map(([code, text]) => html`<p class="check"><input type="radio" id="c${p.id}_${code}" name="choice" value="${code}"><label for="c${p.id}_${code}">Να σταλεί εκπρόθεσμα — ${text}</label></p>`)}
<p class="check"><input type="radio" id="c${p.id}_cov" name="choice" value="covered"><label for="c${p.id}_cov">Καλύφθηκε αλλιώς (π.χ. CardScanner) — να μη σταλεί από εδώ</label></p>
<p><button>Απόφαση</button></p></fieldset></form>`)}
${missing.length > 0 ? note('warn', `${missing.length} κάρτα/-ες στάλθηκαν αλλά η απόδειξη PDF δεν έχει έρθει ακόμη· ζητείται ξανά κάθε μέρα.`) : html``}
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
        await run(argv);
        // The newest folder is this request's (admin.ts writes a new one per request).
        const newest = readdirSync(c.paths.exports).sort().filter((name) => name.startsWith('kartes-')).at(-1);
        const folder = newest === undefined ? c.paths.exports : join(c.paths.exports, newest);
        openInBrowser(folder, c.log);
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
    const night = state?.nightUpdates ?? true;
    return done('Ενημερώσεις', csrf, html`${message}
<p>Έκδοση: <strong>${VERSION}</strong>.</p>
${rolledBack()}
${record === undefined ? html`<p>Δεν έχει γίνει ακόμη έλεγχος για νέα έκδοση (γίνεται μία φορά την ημέρα).</p>` : record.ok ? html`<p>Τελευταίος έλεγχος: ${when(record.checkedIso)}.</p>` : note('warn', `Ο τελευταίος έλεγχος (${when(record.checkedIso)}) απέτυχε: ${record.problem ?? ''}`)}
${record?.installProblem === undefined ? html`` : note('warn', `Η τελευταία προσπάθεια ενημέρωσης (${when(record.installProblem.atIso)}) δεν έγινε: ${record.installProblem.problem}`)}
${record?.available === undefined ? html`` : html`<form method="post" action="/updates"><fieldset><legend>Νέα έκδοση ${record.available}</legend>${csrfField(csrf)}<input type="hidden" name="do" value="install">
<p>Η σελίδα των εργαζομένων σταματά για ένα-δύο λεπτά. Αν η νέα έκδοση δεν ξεκινήσει σωστά, το πρόγραμμα γυρίζει μόνο του στην τωρινή.</p>
<p><button>Ενημέρωση τώρα</button></p></fieldset></form>`}
<form method="post" action="/updates">${csrfField(csrf)}<input type="hidden" name="do" value="check"><p><button class="secondary">Έλεγχος τώρα</button></p></form>
<form method="post" action="/updates"><fieldset><legend>Αυτόματα τη νύχτα</legend>${csrfField(csrf)}<input type="hidden" name="do" value="night">
<p class="check"><input type="checkbox" id="night" name="night" value="on"${night ? html` checked` : html``}><label for="night">Να εγκαθίστανται μόνες τους, 02:00–05:00, όταν κανείς δεν έχει χτυπήσει την τελευταία ώρα και καμία κάρτα δεν είναι καθ’ οδόν.</label></p>
<p><button>Αποθήκευση</button></p></fieldset></form>
<p class="hint">Εγκαθίστανται μόνο εκδόσεις υπογεγραμμένες με το κλειδί του έργου. Ο έλεγχος είναι μία ερώτηση την ημέρα στο GitHub για τη νεότερη έκδοση· τίποτα άλλο δεν στέλνεται, σε κανέναν. Αν ο υπολογιστής είναι κλειστός τη νύχτα, πατήστε «Ενημέρωση τώρα» όταν το βολεύει.</p>`);
  };

  return new Map<string, OwnerPage>([
    ['/', home],
    ['/updates', updates],
    ['/staff', staff],
    ['/devices', devices],
    ['/queue', queue],
    ['/days', days],
    ['/records', records],
    ['/check', check],
    ['/backup', backup],
  ]);
}

