# Κάρτα Εργασίας — η ψηφιακή κάρτα εργασίας της ΕΡΓΑΝΗ ΙΙ

<img src="src/brand/odontia-mark.svg" width="20" height="20" alt=""> Φτιαγμένο από την [Odontia](https://odontia.ai) · *Made by [Odontia](https://odontia.ai)*

**[Ελληνικά](#ελληνικά) · [English](#english)**

Οδηγός / Guide: **[Ελληνικά](docs/guide/el/index.md) · [English](docs/guide/en/index.md)**.
Δωρεάν, χωρίς υποστήριξη και χωρίς εγγύηση· κάθε ιατρείο ευθύνεται για τις δικές του δηλώσεις στην ΕΡΓΑΝΗ.
Free, without support and without warranty; each practice is responsible for its own ΕΡΓΑΝΗ filings.

---

## Ελληνικά

Λογισμικό που τρέχει **ο ίδιος ο εργοδότης**, στον δικό του υπολογιστή, για την **ψηφιακή κάρτα εργασίας**:

- **Οι εργαζόμενοι χτυπούν κάρτα** σε μια σελίδα στον υπολογιστή της υποδοχής, ο καθένας με τον **δικό του κωδικό** —
  ΕΝΑΡΞΗ όταν φτάνει, ΛΗΞΗ όταν φεύγει.
- **Η αποστολή κάθε κάρτας ξεκινά αμέσως**, με ξαναδοκιμές μέσα στο χρονικό όριο πριν από το νόμιμο 15λεπτο αν η ΕΡΓΑΝΗ δεν
  απαντά, και κρατιέται ο **αριθμός πρωτοκόλλου** και το **αποδεικτικό PDF**.
- **Ό,τι δεν περνά, το βλέπει άνθρωπος**: η σελίδα δείχνει ποια κάρτα δεν στάλθηκε, ζητά την αιτία εκπρόθεσμης
  δήλωσης, και θυμίζει την ειδοποίηση της Επιθεώρησης Εργασίας. Προαιρετικά, ειδοποίηση και στο κινητό του εργοδότη.
- **«Ξέχασε να χτυπήσει»**: με βάση το δηλωμένο ωράριο στην ΕΡΓΑΝΗ, η σελίδα λέει ποιος δεν χτύπησε ΕΝΑΡΞΗ ή ΛΗΞΗ —
  την ίδια μέρα, κάθε κομμάτι του σπαστού ωραρίου χωριστά.
- **Το αρχείο των πέντε ετών**: κάθε κάρτα, κάθε απάντηση της ΕΡΓΑΝΗ, και ένα μηνιαίο αντίγραφο όσων κρατά η ΕΡΓΑΝΗ
  (εκείνη τα κρατά μόνο έξι μήνες). Τίποτα δεν σβήνεται. Κάθε εργαζόμενος παίρνει τις δικές του καταγραφές όταν τις
  ζητήσει.
- **Όσα παραρτήματα έχετε**, με ένα αρχείο ανά εργοδότη και έναν περιορισμένο χρήστη ΕΡΓΑΝΗ ανά παράρτημα.

### Ο ένας κανόνας που δεν αλλάζει

**Ο εργοδότης δεν χτυπά ποτέ κάρτα για τον εργαζόμενο.** Δεν υπάρχει τέτοια εντολή ούτε τέτοιο κουμπί: ο κωδικός είναι
του εργαζόμενου και τον ξέρει μόνο εκείνος. Αυτό απαγορεύει ρητά η εγκύκλιος του Υπουργείου, και έτσι είναι χτισμένο.

### Τι δεν κάνει

- Δεν είναι μισθοδοσία· δεν κάνει προσλήψεις, απολύσεις ή δηλώσεις ωραρίου (ΨΟΧΕ) — αυτά μένουν στον λογιστή. Ο
  περιορισμένος χρήστης ΕΡΓΑΝΗ υπάρχει ακριβώς για να μην μπορεί.
- Δεν κρατά ποτέ τους κύριους κωδικούς του εργοδότη, και δεν «διαβάζει» την πύλη της ΕΡΓΑΝΗ.
- Δεν αντικαθιστά το **CardScanner** του Υπουργείου: μένει εγκατεστημένο ως εφεδρεία, για όταν η σελίδα δεν ανοίγει.
- Δεν περιέχει κανένα στοιχείο ασθενών — μόνο τον χρόνο εργασίας του προσωπικού.
- Δεν είναι υπηρεσία στο διαδίκτυο: η σελίδα ανοίγει μόνο σε ιδιωτικό δίκτυο (του ιατρείου, ή Tailscale).

### Εγκατάσταση

**Ο απλός τρόπος — ένα πρόγραμμα για τον υπολογιστή της υποδοχής.** Κατεβάστε το αρχείο για τον υπολογιστή σας από τις
**[Εκδόσεις (Releases)](../../releases/latest)** και ακολουθήστε τον οδηγό **[docs/INSTALL-DESKTOP.md](docs/INSTALL-DESKTOP.md)**:

| Υπολογιστής | Αρχείο |
|---|---|
| Windows 10 / 11 | `karta-ergasias-<έκδοση>-windows-x64-setup.exe` |
| Mac (Apple M1, M2, …) / Mac (Intel) | `…-mac-arm64.zip` / `…-mac-x64.zip` |
| Linux (Ubuntu, Debian, …) | `…-linux-x64.deb` — ή `…-linux-x64.tar.gz` |

Διπλό κλικ, και η ρύθμιση γίνεται στον browser, στα ελληνικά. Ξεκινά μόνο του στη σύνδεση του χρήστη, κρατά αντίγραφο κάθε μέρα
σε USB ή στο Dropbox, και ενημερώνεται μόνο του τη νύχτα — μόνο με εκδόσεις υπογεγραμμένες από το έργο. Ο έλεγχος ενημερώσεων ρωτά μία φορά την ημέρα το GitHub για νεότερη έκδοση· οι δηλώσεις στην ΕΡΓΑΝΗ και οι προαιρετικές ειδοποιήσεις είναι χωριστές συνδέσεις.

**Για τεχνικούς — Docker Compose**, σε έναν υπολογιστή που μένει πάντα ανοιχτός (και για παραρτήματα σε άλλο κτίριο,
μέσω Tailscale). Οδηγός βήμα-βήμα: **[docs/INSTALL.md](docs/INSTALL.md)**.

```sh
docker compose build
docker compose run --rm setup                     # η πρώτη ρύθμιση, στα ελληνικά
docker compose run --rm stamp ergani admin init   # μία φορά
docker compose run --rm archive ergani pull --init-store
docker compose up -d
docker compose exec stamp ergani check            # ΜΟΝΟ ανάγνωση: ελέγχει κάθε χρήστη ΕΡΓΑΝΗ
```

**Με βοηθό τεχνητής νοημοσύνης**: δώστε του τη σελίδα [docs/AI-ASSISTANT-INSTALL.md](docs/AI-ASSISTANT-INSTALL.md).

Πριν από όλα, φτιάξτε στην ΕΡΓΑΝΗ έναν περιορισμένο χρήστη για κάθε παράρτημα: **[docs/ERGANI-USER.md](docs/ERGANI-USER.md)**.
Οι καθημερινές εντολές (Docker): [docs/ADMIN.md](docs/ADMIN.md) · Το φύλλο για το προσωπικό: [docs/STAFF-SHEET.md](docs/STAFF-SHEET.md).

### Χωρίς εγγύηση

Διατίθεται δωρεάν, **χωρίς καμία εγγύηση**, με την άδεια [EUPL-1.2](LICENSE) (υπάρχει και σε επίσημη ελληνική
μετάφραση). Κάθε κάρτα στο πραγματικό μητρώο είναι νόμιμη δήλωση του εργοδότη· η ευθύνη για τη χρήση είναι δική του.
Διαβάστε τους κανόνες του λογισμικού: [docs/RULES.md](docs/RULES.md). Σφάλμα ασφαλείας: [SECURITY.md](SECURITY.md).

---

*Φτιάχτηκε σε οδοντιατρείο, για τις δικές του ανάγκες. Το [Odontia](https://odontia.ai) κάνει αυτό — και πολλά ακόμη —
για όλο το ιατρείο.*

---

## English

Software **an employer runs itself**, on its own machine, for Greece's **digital work card** (ψηφιακή κάρτα εργασίας),
filed to the Ministry of Labour's **ΕΡΓΑΝΗ ΙΙ** register.

- **Staff stamp their own** ΕΝΑΡΞΗ (start) and ΛΗΞΗ (end) on a page at the reception computer, each with their own PIN.
- **Sending starts at once**, with retries inside the sending window before the statutory 15 minutes while ΕΡΓΑΝΗ does not answer; the protocol
  number and the proof PDF are kept.
- **What does not go through reaches a person**: the page shows the card, asks for the late-filing reason, and reminds
  the employer to notify the labour inspectorate. Optional pushes to the owner's phone (a self-hosted ntfy).
- **"Forgot to stamp"** alarms the same day, from the schedule declared in ΕΡΓΑΝΗ — each interval of a split shift on
  its own.
- **The five-year record**: every card, every answer, and a monthly copy of what ΕΡΓΑΝΗ holds (it keeps six months).
  Append-only, enforced by the database. Each employee can be given their own records.
- **Any number of branches**: one store per employer, one restricted ΕΡΓΑΝΗ user per branch.

**The one rule that does not bend: the employer never stamps for an employee.** There is no such command or button.

It does not do payroll, hirings, dismissals or schedule declarations; it never holds the employer's master codes or
scrapes the portal; it keeps the ministry's CardScanner app as the fallback; it holds no patient data; and the page is
served on a private network only.

**Install**: one program per system — Windows, Mac, Linux — from the [Releases](../../releases/latest), set up in the
browser ([docs/INSTALL-DESKTOP.md](docs/INSTALL-DESKTOP.md), Greek, with an English summary). It is not signed with a paid
certificate (the first install needs one extra click), and it updates itself at night with releases signed by the
project's key only. For technical setups: Docker Compose, [docs/INSTALL.md](docs/INSTALL.md); for AI assistants:
[docs/AI-ASSISTANT-INSTALL.md](docs/AI-ASSISTANT-INSTALL.md).
**Design**: [docs/RULES.md](docs/RULES.md), [docs/DECISIONS.md](docs/DECISIONS.md),
[docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md). **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md).
**Security**: [SECURITY.md](SECURITY.md).

Free, **with no warranty of any kind**, under the [EUPL-1.2](LICENSE). In the real register every card is a legally
binding declaration by the employer, who is responsible for its use.

*Built in a dental practice, for its own use. [Odontia](https://odontia.ai) does this — and much more — for the whole
practice.*
