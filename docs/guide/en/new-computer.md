# New computer — recovery

If the computer fails or is replaced, staff use **CardScanner until recovery and checking are complete**. The owner does not stamp for another person.

You need a [complete backup folder](backups.md), with both SQLite files and `recovery.json`, and the owner password used then.

## Step by step

1. **Stop the old installation** if it still works. Two computers must not send. Preserve its old record.
2. Install the same or a newer version for the replacement system and sign into the computer user account that will run it.
3. Connect the backup medium or wait for the latest `karta-…` folder to download fully. Check that both SQLite files and `recovery.json` are present.
4. In **Πρώτη ρύθμιση → Επαναφορά από πλήρες αντίγραφο ασφαλείας (First setup → Recover from a complete backup)** enter the folder's full path and its owner password. Do not add the employer or staff again. An existing record is not overwritten.
5. Sign in with the earlier owner password. The page says **Η αποστολή παραμένει σταματημένη (Sending remains stopped)**. Sending and the staff page stay stopped even after a restart.
6. **With the accountant, check every old unresolved card in ΕΡΓΑΝΗ**. It may have arrived after the snapshot. For each select **Ελέγχθηκε / ανατέθηκε στον λογιστή — να μη σταλεί (Checked / assigned to accountant — do not send)**. The accountant handles necessary corrections. A very recent card or active late-send decision may first need its existing sending window to expire.
7. Check cards **after the backup** together too: they are absent from the snapshot. Confirm the old installation is stopped, then choose **Ολοκλήρωση ελέγχου και εκκίνηση (Complete checks and start)**. Sending and the staff page now open. Cards with a saved successful outcome are not filed again.
8. Check the staff page's private address. If it changed, with the program closed adjust `ERGANI_BIND_ADDRESS` in the local `settings.env` or have the technician preserve the correct address. Do not share that file: it contains a password. Enrol new browsers/phones under **Συσκευές (Devices)**. Saved PINs are retained.
9. Run the [connection check](connection-check.md) and repeat your portal permission confirmation. Choose the correct backup folder, select **Αντίγραφο τώρα (Back up now)** and check success. Check the monthly archive on Home too.

## If recovery is interrupted or something is missing

Sending remains stopped. Preserve the files, close the program and repeat in a **new empty data folder** outside code folders. To recover on the same computer, first preserve the entire previous data folder under another name. Default locations are:

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Karta Ergasias` |
| Mac | `~/Library/Application Support/Karta Ergasias` |
| Linux | `~/.local/share/karta-ergasias` or your configured XDG folder |

Do not copy only the two SQLite files over active settings or start an empty record to conceal a loss.

## What does not come back

The snapshot lacks later cards, staff, PIN/device changes, decisions and PDFs. The monthly archive can reread older movements within the available window; **it does not reconstruct the local record or read the current month**. For an older backup without `recovery.json`, preserve the records and separately retained settings and seek technical help without sending personal data or passwords.

## Docker — separate handling

The technician uses their own encrypted backup of both volumes, exports and `.env`. Restore outside code folders, with the old installation and `stamp` service stopped and private file permissions. With the accountant reconcile snapshot-pending cards and later cards **before restarting the sender**. Docker has no automatic guided-recovery hold. Do not edit or delete database rows.

Detailed reference: [NEW-COMPUTER.md](../../NEW-COMPUTER.md).
