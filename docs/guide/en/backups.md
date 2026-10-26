# Backups and recovery

Keep a backup **on another medium**, not only the same disk. It contains staff data: restrict access and protect it as carefully as the original record.

## Current desktop automatic backup

On **Αντίγραφα**, choose a connected USB drive or a sync folder you control. The daily backup copies `stamp.sqlite`, `records.sqlite` and any exports. It keeps the newest 30 complete backups. A disconnected USB drive or missing folder is a failure, not a successful backup.

**This version's limit:** automatic backups omit `settings.env` and `desktop.json`. The two SQLite files alone do not provide complete recovery onto a new computer. Full transfer of settings and protected credentials is not yet documented as a rehearsed procedure in this guide.

## Restore records on the same computer

Only with the program stopped and its current settings retained: preserve a protected copy of the existing folder, then restore `stamp.sqlite` into `stamp` and `records.sqlite` into `records`. Do not mix employers or backup dates. Seek technical help if you cannot identify a complete copy.

| System | Default data folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Karta Ergasias` |
| Mac | `~/Library/Application Support/Karta Ergasias` |
| Linux | `~/.local/share/karta-ergasias` (or your configured XDG data folder) |

Do not put staff records in a code folder or share settings/passwords.

## Docker and replacing a computer

For a technical installation, preserve both volumes **and** a separate protected copy of `.env`, accessible only to the owner. The technician must make consistent SQLite copies, not copy during a write. Preserve the original machine/media. Do not start a second active installation that sends the same pending cards.

Use [CardScanner](daily.md) while a failed computer's page is unavailable. A new empty installation does not recover the old record. Full replacement-computer instructions will follow the recovery rehearsal; this limit is also in [KNOWN-LIMITS.md](../../KNOWN-LIMITS.md).
