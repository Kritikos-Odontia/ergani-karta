# Complete backups

Keep a backup **on another medium**, not only the same disk. In the desktop program open **Αντίγραφα (Backups)**, choose a connected USB drive or a sync folder you control, then select **Αποθήκευση και αντίγραφο τώρα (Save and back up now)**. Check Home for success. The daily backup retains the newest 30 complete copies.

Each copy has its own folder under `Karta Ergasias backups/karta-…/`:

| Content | What it holds |
|---|---|
| `stamp.sqlite` | Staff, PINs, devices, cards, decisions, responses and available proof PDFs. |
| `records.sqlite` | The monthly archive already read. |
| `exports/`, if present | Exported pages and files. |
| `recovery.json` | Encrypted settings, ΕΡΓΑΝΗ password and owner access, plus integrity checks for both SQLite files. |

## Which password recovery needs

Keep **the owner password used when that particular backup was created** in your password manager. Changing today's password does not change older backups. Without the correct earlier password, the encrypted recovery settings cannot be opened. A qualified technician can still read the two record files; do not send your data or passwords through a chat.

Encryption protects the backup's settings. **The SQLite files and exports are not encrypted by the program.** Protect the USB drive, sync account and computer like the staff record. The live local settings file retains its existing private-file protection.

## Check availability

A disconnected USB drive or missing folder is a failure. Check the last attempt on Home. A cloud-only folder is insufficient for recovery: wait for it to download fully. A USB drive lost with the computer is not an available backup.

For complete recovery follow [New computer — recovery](new-computer.md). **Do not copy just the two SQLite files over an active installation**: that bypasses the hold and checks before sending resumes. Older copies without `recovery.json` cannot use guided complete recovery; preserve them and take a new complete backup while the original machine works.

Docker needs your own backup tool: both volumes, exports and `.env` in an encrypted backup, using consistent SQLite copies. Guided recovery and its automatic hold apply to the desktop program. See the [separate technical handling](new-computer.md).
