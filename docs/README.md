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
- [Έλεγχος σύνδεσης και δικαιωμάτων](guide/el/connection-check.md) · [Connection and permission checks](guide/en/connection-check.md)
- [Κάθε μέρα — προσωπικό και CardScanner](guide/el/daily.md) · [Daily use — staff and CardScanner](guide/en/daily.md)
- [Οι δικές μου κινήσεις](guide/el/employee-history.md) · [My own history](guide/en/employee-history.md)
- [Η καθημερινή εικόνα του εργοδότη](guide/el/owner-overview.md) · [Owner daily overview](guide/en/owner-overview.md)
- [Ρυθμίσεις και παραρτήματα](guide/el/settings.md) · [Settings and branches](guide/en/settings.md)
- [Μετά από διακοπή — ουρά αποστολής](guide/el/outage-queue.md) · [After an outage — sending queue](guide/en/outage-queue.md)
- [Αποτυχίες αποστολής και ο λογιστής](guide/el/failures.md) · [Failed submissions and the accountant](guide/en/failures.md)
- [Καταγραφές και αποδεικτικά](guide/el/records.md) · [Records and receipts](guide/en/records.md)
- [Αρχείο για τον λογιστή](guide/el/accountant-export.md) · [Accountant export](guide/en/accountant-export.md)
- [Ημερολόγιο υπενθυμίσεων](guide/el/reminder-calendar.md) · [Reminder calendar](guide/en/reminder-calendar.md)
- [Πλήρη αντίγραφα ασφαλείας](guide/el/backups.md) · [Complete backups](guide/en/backups.md)
- [Νέος υπολογιστής — επαναφορά](guide/el/new-computer.md) · [New computer — recovery](guide/en/new-computer.md)
- [Ενημερώσεις του προγράμματος](guide/el/updates.md) · [Program updates](guide/en/updates.md)
- [Αντιμετώπιση προβλημάτων](guide/el/troubleshooting.md) · [Troubleshooting](guide/en/troubleshooting.md)
- [Λήψη, κώδικας, άδεια και ασφάλεια](guide/el/download.md) · [Download, source, licence and security](guide/en/download.md)

## Reference pages — stable links

The chapters above are the master bilingual public guide. Existing detailed reference URLs remain available to the program and contributors:

- [Desktop installation](INSTALL-DESKTOP.md), [Docker installation](INSTALL.md), [AI assistant installation](AI-ASSISTANT-INSTALL.md)
- [Restricted users](ERGANI-USER.md), [owner commands](ADMIN.md), [printable staff sheet](STAFF-SHEET.md), [notifications](NOTIFICATIONS.md)
- [Owner overview](OWNER-OVERVIEW.md), [settings and branches](SETTINGS.md), [accountant and calendar](ACCOUNTANT-CALENDAR.md), [new-computer recovery](NEW-COMPUTER.md)
- [Rules](RULES.md), [decisions](DECISIONS.md), [known limits](KNOWN-LIMITS.md), [signing](SIGNING.md)

`guide/chapters.json` lists published chapters and title-only placeholders. Every published chapter has Greek and English Markdown. Keep both languages true to the same program version.

The website importer takes an explicit full Git commit from a local checkout and vendors that snapshot, including the needed images. The site build uses the pinned files without fetching GitHub or ΕΡΓΑΝΗ. Re-import after the manual changes; the displayed package version and source commit identify the snapshot. Release preparation must pin the released commit and matching package version; re-import if the release changes. All 22 chapters now have complete Greek and English text, with no planned placeholders.
