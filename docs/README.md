# Εγχειρίδιο / Manual

**[Ελληνικά — οδηγός](guide/el/index.md) · [English — guide](guide/en/index.md)**

Δωρεάν, χωρίς υποστήριξη και χωρίς εγγύηση. Κάθε ιατρείο παραμένει υπεύθυνο για τις δικές του δηλώσεις στην ΕΡΓΑΝΗ.

Free, without support and without warranty. Each practice remains responsible for its own ΕΡΓΑΝΗ filings.

## Κεφάλαια / Chapters

- [Κάρτα Εργασίας — ο οδηγός σας](guide/el/index.md) · [Work Card — your guide](guide/en/index.md)
- [Απαιτήσεις και γνωστά όρια](guide/el/requirements.md) · [Requirements and known limits](guide/en/requirements.md)
- [Εγκατάσταση σε Windows](guide/el/windows.md) · [Install on Windows](guide/en/windows.md)
- [Εγκατάσταση σε Mac](guide/el/mac.md) · [Install on Mac](guide/en/mac.md)
- [Εγκατάσταση σε Linux](guide/el/linux.md) · [Install on Linux](guide/en/linux.md)
- [Τεχνική εγκατάσταση — Docker](guide/el/docker.md) · [Technical installation — Docker](guide/en/docker.md)
- [Περιορισμένοι χρήστες, PIN και συσκευές](guide/el/access.md) · [Restricted users, PINs and devices](guide/en/access.md)
- [Κάθε μέρα — προσωπικό και CardScanner](guide/el/daily.md) · [Daily use — staff and CardScanner](guide/en/daily.md)
- [Αποτυχίες αποστολής και ο λογιστής](guide/el/failures.md) · [Failed submissions and the accountant](guide/en/failures.md)
- [Καταγραφές και αποδεικτικά](guide/el/records.md) · [Records and receipts](guide/en/records.md)
- [Αντίγραφα και επαναφορά](guide/el/backups.md) · [Backups and recovery](guide/en/backups.md)
- [Ενημερώσεις του προγράμματος](guide/el/updates.md) · [Program updates](guide/en/updates.md)
- [Αντιμετώπιση προβλημάτων](guide/el/troubleshooting.md) · [Troubleshooting](guide/en/troubleshooting.md)
- [Λήψη, κώδικας, άδεια και ασφάλεια](guide/el/download.md) · [Download, source, licence and security](guide/en/download.md)

## Επόμενος γύρος — μόνο τίτλοι / Next round — titles only

- Η καθημερινή εικόνα του εργοδότη / Owner daily overview — εκκρεμεί / planned
- Ρυθμίσεις και παραρτήματα / Settings and branches — εκκρεμεί / planned
- Εξαγωγή για τον λογιστή / Accountant export — εκκρεμεί / planned
- Ημερολόγιο υπενθυμίσεων / Reminder calendar — εκκρεμεί / planned
- Ουρά μετά από διακοπή / Queue after an outage — εκκρεμεί / planned
- Το ιστορικό μου με PIN / My history with a PIN — εκκρεμεί / planned

## Reference pages — stable links

The chapters above are the master bilingual public guide. Existing detailed reference URLs remain available to the program and contributors:

- [Desktop installation](INSTALL-DESKTOP.md), [Docker installation](INSTALL.md), [AI assistant installation](AI-ASSISTANT-INSTALL.md)
- [Restricted users](ERGANI-USER.md), [owner commands](ADMIN.md), [printable staff sheet](STAFF-SHEET.md), [notifications](NOTIFICATIONS.md)
- [Rules](RULES.md), [decisions](DECISIONS.md), [known limits](KNOWN-LIMITS.md), [signing](SIGNING.md)

`guide/chapters.json` lists published chapters and title-only placeholders. Every published chapter has Greek and English Markdown. Keep both languages true to the same program version.

The website importer takes an explicit full Git commit from a local checkout and vendors that snapshot, including the needed images. The site build uses the pinned files without fetching GitHub or ΕΡΓΑΝΗ. Re-import after the manual changes; the displayed package version and source commit identify the snapshot. Release preparation must pin the final released commit after round 2.
