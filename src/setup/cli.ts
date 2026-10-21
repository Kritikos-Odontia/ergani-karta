// SPDX-License-Identifier: EUPL-1.2
import { chownSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { branchCodesOf, isValidAfm } from '../config.js';
import { athensDate } from '../ergani/exbase.js';
import { monthsBefore } from '../records/daily.js';
import { INSTANCE_NAME } from '../stamp/config.js';
import { answerProblems, bindAddressProblem, settingsFile, valueProblem, type BranchAnswers, type SetupAnswers } from './settings.js';

/**
 * THE GUIDED FIRST SETUP — `ergani setup`, in Greek: it asks for the employer, its branches and each branch's
 * restricted ΕΡΓΑΝΗ login, where the page is published, and the optional phone and monitors; it checks every answer as
 * it is given, and writes the employer's settings file (0600). It never overwrites one, and it sends nothing anywhere:
 * the first contact with ΕΡΓΑΝΗ is `ergani check`, which only reads.
 *
 *   docker compose run --rm setup          (writes ./.env beside docker-compose.yml)
 *
 * ⛔ The passwords are typed without echo. They go into the file and nowhere else — never into a log or the screen.
 */

export interface SetupIo {
  ask: (question: string) => Promise<string>;
  /** A question whose answer is not shown as it is typed. */
  askSecret: (question: string) => Promise<string>;
  out: (line: string) => void;
  now: () => number;
}

/** Ask until `problem` says the answer is fine; `fallback` is taken for an empty answer. */
async function askValid(
  io: SetupIo,
  question: string,
  problem: (answer: string) => string | undefined,
  fallback?: string,
  secret = false,
): Promise<string> {
  for (;;) {
    const shown = fallback === undefined || fallback === '' ? question : `${question} [${fallback}]`;
    const raw = (secret ? await io.askSecret(`${shown}: `) : await io.ask(`${shown}: `)).trim();
    const answer = raw === '' && fallback !== undefined ? fallback : raw;
    const why = problem(answer);
    if (why === undefined) return answer;
    io.out(`  ✗ ${why}`);
  }
}

const yes = (answer: string) => /^(ν|ναι|y|yes)$/i.test(answer);
const yesNo = (answer: string) => (/^(ν|ναι|y|yes|ο|όχι|οχι|n|no)$/i.test(answer) ? undefined : 'ναι ή όχι');

/** The whole conversation. Returns the answers, checked; nothing is written here. */
export async function askSetup(io: SetupIo): Promise<SetupAnswers> {
  io.out('Κάρτα Εργασίας — πρώτη ρύθμιση.');
  io.out('Θα χρειαστείτε: τον ΑΦΜ του εργοδότη, τον αριθμό κάθε παραρτήματος όπως τον έχει η ΕΡΓΑΝΗ (η έδρα είναι 0),');
  io.out('και για κάθε παράρτημα έναν ΠΕΡΙΟΡΙΣΜΕΝΟ χρήστη ΕΡΓΑΝΗ (docs/ERGANI-USER.md) — ποτέ τους κύριους κωδικούς.');
  io.out('');

  const instance = await askValid(io, 'Σύντομο όνομα του ιατρείου για τον υπολογιστή (λατινικά, π.χ. iatreio-kentro)', (a) =>
    INSTANCE_NAME.test(a) ? undefined : 'μικρά λατινικά, ψηφία και παύλες, 2–31 χαρακτήρες, να αρχίζει με γράμμα',
  );
  const label = await askValid(io, 'Το όνομα που θα γράφει η σελίδα (π.χ. «Οδοντιατρείο Παράδειγμα»)', (a) =>
    a === '' ? 'δώστε όνομα' : valueProblem(a, 'allowed'),
  );
  const employerAfm = await askValid(io, 'ΑΦΜ του εργοδότη', (a) => (isValidAfm(a) ? undefined : 'δεν είναι έγκυρος ΑΦΜ (9 ψηφία, ψηφίο ελέγχου)'));
  const codes = branchCodesOf(
    await askValid(
      io,
      'Αριθμοί παραρτημάτων όπως στην ΕΡΓΑΝΗ, με κόμμα (η έδρα είναι 0)',
      (a) => {
        try {
          branchCodesOf(a);
          return undefined;
        } catch {
          return 'αριθμοί χωρισμένοι με κόμμα, χωρίς μηδενικά μπροστά (π.χ. 0 ή 0,1)';
        }
      },
      '0',
    ),
  );

  const branches: BranchAnswers[] = [];
  for (const code of codes) {
    io.out('');
    io.out(`── Παράρτημα ${code}${code === '0' ? ' (έδρα)' : ''}`);
    const branchLabel =
      codes.length > 1
        ? await askValid(io, 'Όνομα του παραρτήματος στη σελίδα (π.χ. «Κέντρο»)', (a) =>
            a === '' ? 'δώστε όνομα' : a.length > 40 ? 'ως 40 χαρακτήρες' : valueProblem(a, 'allowed'),
          )
        : '';
    const inspectorateEmail = await askValid(
      io,
      'Email της Επιθεώρησης Εργασίας της περιοχής (για τις ειδοποιήσεις βλάβης· κενό αν δεν το ξέρετε ακόμη)',
      (a) => (a === '' || /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(a) ? undefined : 'δεν μοιάζει με email'),
      '',
    );
    const schedule = yes(
      await askValid(
        io,
        'Έχει δηλωμένο σταθερό ωράριο στην ΕΡΓΑΝΗ; (ναι: η σελίδα ειδοποιεί όποιον ξέχασε την ΕΝΑΡΞΗ· όχι: μόνο τη ΛΗΞΗ)',
        yesNo,
        'ναι',
      ),
    )
      ? 'ergani'
      : 'none';
    const username = await askValid(io, 'Περιορισμένος χρήστης ΕΡΓΑΝΗ του παραρτήματος — όνομα χρήστη', (a) =>
      a.length < 8 || a.length > 20 ? '8–20 χαρακτήρες' : valueProblem(a, 'refused'),
    );
    let password = '';
    for (;;) {
      password = await askValid(
        io,
        'Κωδικός του χρήστη (δεν φαίνεται όσο γράφετε)',
        (a) => (a.length < 8 || a.length > 12 ? '8–12 χαρακτήρες' : valueProblem(a, 'refused')),
        undefined,
        true,
      );
      if ((await io.askSecret('Ο ίδιος κωδικός ξανά: ')).trim() === password) break;
      io.out('  ✗ οι δύο κωδικοί διαφέρουν — ξανά');
    }
    branches.push({ code, label: branchLabel, inspectorateEmail, schedule, username, password });
  }

  io.out('');
  io.out('── Πού θα ανοίγει η σελίδα');
  io.out('Μια ΙΔΙΩΤΙΚΗ διεύθυνση αυτού του υπολογιστή: του δικτύου του ιατρείου (π.χ. 192.168.1.20) ή του Tailscale (100.x).');
  io.out('Αν το δίκτυο του ιατρείου το μοιράζονται κι άλλοι (κοινόχρηστο ή Wi-Fi επισκεπτών), διαλέξτε το Tailscale: εκεί οι κωδικοί περνούν κρυπτογραφημένοι.');
  const bindAddress = await askValid(io, 'Διεύθυνση', (a) => bindAddressProblem(a), '127.0.0.1');
  const port = Number(await askValid(io, 'Θύρα', (a) => (/^\d{4,5}$/.test(a) && Number(a) >= 1024 && Number(a) <= 65535 ? undefined : '1024–65535'), '8880'));
  const cookieSecure = yes(await askValid(io, 'Θα τη σερβίρει HTTPS proxy μπροστά της; (αν δεν ξέρετε: όχι)', yesNo, 'όχι'));

  io.out('');
  io.out('── Προαιρετικά: ειδοποιήσεις στο κινητό του εργοδότη (δικός σας ntfy server — docs/NOTIFICATIONS.md)');
  const ntfyUrl = await askValid(
    io,
    'Διεύθυνση topic, https://<server>/<topic> (κενό: χωρίς ειδοποιήσεις)',
    (a) => (a === '' || /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9_-]{1,64}$/.test(a) ? undefined : 'https://<server>/<topic>'),
    '',
  );
  const ntfyToken =
    ntfyUrl === ''
      ? ''
      : await askValid(io, 'Token της υπηρεσίας (write-only)', (a) => (a === '' ? 'δώστε το token' : valueProblem(a, 'refused')), undefined, true);
  const stampHeartbeatUrl = await askValid(io, 'Παρακολούθηση της σελίδας: push URL (π.χ. Uptime Kuma· κενό: καμία)', (a) => (a === '' || /^https?:\/\/\S+$/.test(a) ? undefined : 'http(s) διεύθυνση'), '');
  const archiveHeartbeatUrl = await askValid(io, 'Παρακολούθηση του μηνιαίου αρχείου: push URL (κενό: καμία)', (a) => (a === '' || /^https?:\/\/\S+$/.test(a) ? undefined : 'http(s) διεύθυνση'), '');

  io.out('');
  const lastMonth = monthsBefore(athensDate(io.now()).slice(0, 7), 1);
  const archiveFrom = await askValid(io, 'Από ποιον μήνα να κρατά το μηνιαίο αρχείο (YYYY-MM)', (a) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(a) ? undefined : 'YYYY-MM'), lastMonth);

  io.out('');
  io.out('── ΕΡΓΑΝΗ: δοκιμαστικό ή πραγματικό;');
  io.out('Το δοκιμαστικό (trial) σημαδεύει ό,τι δηλώνεται «ΑΚΥΡΟ». Το πραγματικό: κάθε κάρτα είναι πραγματική δήλωση.');
  const live = yes(await askValid(io, 'Να ρυθμιστεί για το ΠΡΑΓΜΑΤΙΚΟ μητρώο τώρα;', yesNo, 'όχι'));
  const realm =
    live && (await io.ask('Γράψτε ΠΡΑΓΜΑΤΙΚΟ για να το επιβεβαιώσετε: ')).trim() === 'ΠΡΑΓΜΑΤΙΚΟ' ? 'production' : 'trial';
  if (live && realm === 'trial') io.out('  Δεν επιβεβαιώθηκε — ρυθμίζεται το δοκιμαστικό.');

  return {
    instance,
    label,
    employerAfm,
    realm,
    branches,
    bindAddress,
    port,
    cookieSecure,
    ntfyUrl,
    ntfyToken,
    stampHeartbeatUrl,
    archiveHeartbeatUrl,
    archiveFrom,
  };
}

/** The next steps, printed after the file is written. */
/** The setup's last line (no price: what it costs is said on the site). */
export const FOR_YOU = 'Δεν θέλετε να το φροντίζετε εσείς; Η Odontia το τρέχει για εσάς — https://odontia.ai';

export function nextSteps(a: SetupAnswers): string[] {
  const enroll =
    a.branches.length > 1
      ? a.branches.map((b) => `     docker compose exec stamp ergani admin enroll --branch ${b.code} --label "Υποδοχή"`)
      : ['     docker compose exec stamp ergani admin enroll --label "Υποδοχή"'];
  return [
    'Επόμενα βήματα (docs/INSTALL.md):',
    '  1. docker compose run --rm stamp ergani admin init         — δημιουργεί το αρχείο καρτών, μία φορά',
    '  2. docker compose run --rm archive ergani pull --init-store — δημιουργεί το μηνιαίο αρχείο, μία φορά',
    '  3. docker compose up -d',
    '  4. docker compose exec stamp ergani check                   — ΜΟΝΟ ανάγνωση: ελέγχει κάθε χρήστη ΕΡΓΑΝΗ',
    '  5. docker compose exec stamp ergani admin add --afm … --surname … --first-name …   (για κάθε εργαζόμενο)',
    '  6. για κάθε υπολογιστή υποδοχής:',
    ...enroll,
    `     και ανοίξτε στον υπολογιστή υποδοχής http://${a.bindAddress}:${a.port}/enroll/…`,
    '',
    FOR_YOU,
  ];
}

/** `ergani setup [--out <file>]` — the default file is `/install/.env`, the folder Compose mounts for it. */
export async function runSetupCli(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { out: { type: 'string', default: '/install/.env' } },
    strict: true,
    allowPositionals: false,
  });
  const path = values.out;
  if (!isAbsolute(path)) throw new Error('--out must be an absolute path.');
  // ⚠ The file goes beside docker-compose.yml, where Compose reads it. A folder without it is not the installation —
  // or the folder was never mounted (a path Docker does not share): a file written there would vanish with the
  // container, while this said «written».
  if (!existsSync(join(dirname(path), 'docker-compose.yml'))) {
    throw new Error('The settings file goes beside docker-compose.yml: run `docker compose run --rm setup` from the installation folder.');
  }
  if (existsSync(path)) {
    throw new Error('A settings file already exists there. It is never overwritten: move it aside first if you mean to start again.');
  }
  const io = terminalIo();
  try {
    const answers = await askSetup(io.io);
    const problems = answerProblems(answers);
    if (problems.length > 0) {
      for (const p of problems) io.io.out(`✗ ${p}`);
      return 1;
    }
    // `wx`: never over a file that appeared meanwhile; 0600: it holds the ΕΡΓΑΝΗ logins.
    writeFileSync(path, settingsFile(answers, new Date().toISOString()), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Run as root in its container (docker-compose.yml, `setup`): the file goes to whoever owns the folder it is in, so
    // that person's `docker compose` can read it — and nobody else can.
    if (process.getuid?.() === 0) {
      const folder = statSync(dirname(path));
      chownSync(path, folder.uid, folder.gid);
    }
    io.io.out('');
    io.io.out('✓ Οι ρυθμίσεις γράφτηκαν (μόνο για τον ιδιοκτήτη του αρχείου). Τίποτα δεν στάλθηκε πουθενά.');
    for (const line of nextSteps(answers)) io.io.out(line);
    return 0;
  } finally {
    io.close();
  }
}

/**
 * The terminal: readline for answers, with no echo for secrets. ⓘ readline echoes what is typed through its
 * `_writeToOutput` (the callback interface has it; the promise one does not): while a secret is asked, nothing typed
 * reaches the screen. A terminal without it fails here, before any question — never by showing a password.
 */
export function terminalIo(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { io: SetupIo; close: () => void } {
  if (input.isTTY !== true) throw new Error('setup asks questions: run it in a terminal (docker compose run --rm setup).');
  // ⛔ No history: readline keeps every answer — a hidden password too — and ↑ at a later question would show it.
  const rl = createInterface({ input, output, terminal: true, historySize: 0 });
  const writer = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = writer._writeToOutput?.bind(rl);
  if (original === undefined) {
    rl.close();
    throw new Error('this terminal cannot hide a typed password; nothing was asked.');
  }
  let muted = false;
  writer._writeToOutput = (text: string) => {
    if (!muted) original(text);
  };
  const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  return {
    io: {
      ask: question,
      askSecret: async (q) => {
        output.write(q);
        muted = true;
        try {
          return await question('');
        } finally {
          muted = false;
          output.write('\n');
        }
      },
      out: (line) => console.log(line),
      now: Date.now,
    },
    close: () => rl.close(),
  };
}
