# Known limits

What is known and not fixed, and why. Stated once, as fact. An entry is removed when it is fixed.

## The owner overview currently reads individual archive pulls

The desktop Home page reads the latest backup attempt from `desktop.json` and the monthly pulls from the local record.
Until the readiness work's persisted daily status is joined, its last complete archive read proves one branch/month,
not a successful whole daily archive run or comparison-page writes. Failed or absent latest reads in the current
one-to-five-month archive window are listed by month and branch. A newer failed read does not hide the last complete
one. Failures before a pull is recorded, and failed comparison-page writes, cannot be inferred from these pulls; the
screen says so. The reader is isolated in `src/desktop/owner/overview-maintenance.ts` for that integration.

The overview is a snapshot, refreshed by reloading the page. Its connection monitor detects ten minutes without an
HTTP answer, including the initial observation period after startup; absence of that alarm is not proof of a working
login or restricted permissions. The missing-PDF list includes newly filed cards still in their early automatic
retrieval attempts, as well as older failures; it explicitly says when the existing 183-day retrieval limit has passed.

## How ΕΡΓΑΝΗ merges several intervals in one day is unmeasured

A split shift (σπαστό ωράριο) is four declarations against one working day. Whether ΕΡΓΑΝΗ keeps two intervals or
reads one long one from earliest ΕΝΑΡΞΗ to latest ΛΗΞΗ is not settled by the documentation (the current manual and an
older paragraph disagree). Until it is measured, rule 3's bound stands (docs/RULES.md), and a forgotten midday ΛΗΞΗ is
exactly the missed card that could turn a split day into one long one — which is why the «forgot to stamp» alarms check
each declared interval on its own.

The read-only review of already-held records on 26 October 2026 found no split-shift person-day. No new filing or ministry call was made. Fabricated split-day tests exercise the local sending bound; they do not measure the ministry's merge.

## Overnight ministry read-back remains unconfirmed

The same stored-record review found no overnight exit. The program preserves a post-midnight exit's original working day, including across branches, and fabricated tests cover it. No observed overnight monthly answer confirms the ministry's date, time or overnight-flag shape yet; an unrecognised answer is refused, never recorded as an empty day.

## Without a calendar entry, who is due today comes from last month's schedule

ΕΡΓΑΝΗ answers schedule reads a month late, so the alarms take the same weekday in the latest week it answers. On an
ordinary day of a fixed weekly pattern that is right. It is wrong, and says «check», when: a person is back from
leave since then (missed), a person is newly on leave (a false alarm), or the accountant re-declared the schedule
afterwards (not seen). The owner's reminder calendar can mark leave, replacement hours and closed/open dates; national
holidays are built in. These entries affect reminders only, never file a schedule, and do not replace the accountant's
declarations. Transfers of May Day and local or exceptional holidays need an owner entry after checking with the
accountant; they are not fetched automatically. See [ACCOUNTANT-CALENDAR.md](ACCOUNTANT-CALENDAR.md).

## A branch with no schedule or calendar hours cannot see a forgotten midday ΛΗΞΗ

On a branch that reads no schedule (`SCHEDULE=none`) and has no replacement hours in the reminder calendar, «forgot ΛΗΞΗ» fires only for a stint still open at 21:00. A
split day there — ΕΝΑΡΞΗ 09:00, the 14:00 ΛΗΞΗ forgotten, ΕΝΑΡΞΗ 17:00, ΛΗΞΗ 21:00 — raises no alarm, and ΕΡΓΑΝΗ
holds 09:00–21:00. The other way round, a person working past 21:00 there is named as «not stamped out» while still at
work. A branch that reads its schedule catches both at the interval's end + 30′.

## An ΕΡΓΑΝΗ request already in flight still takes time

Fresh cards are reconsidered after every send and go ahead of unrelated late cards. The late backlog gets one card
per pass; earlier due cards of the same person and working day still go first, across branches. A failed ΕΝΑΡΞΗ's
retry gap never holds back a fresh ΛΗΞΗ (docs/DECISIONS.md).

A send already in flight is allowed to finish: stopping it cannot undo what ΕΡΓΑΝΗ may have received. Requests time
out after 20 seconds each, but sign-in, token renewal and «too many requests» waits can make an attempt take minutes.
A fresh stamp can still wait for that one attempt, and an ΕΡΓΑΝΗ that remains unavailable can still outlast its window.
No filing is promised: the page keeps the result and sends an unconfirmed card to the human queue at minute 14.

## Personal history shows this application's local record

After choosing their own PIN, active staff who stamp can read their own cards on the staff page, at every branch.
The view starts with the current month and shows the newest 100 cards of the chosen working-day range; «Παλαιότερες
κινήσεις» reads the next page. It is a snapshot: «Εμφάνιση» reads the current filing results again. It does not read
back today's ministry register or confirm cards filed through CardScanner or by the accountant. «Καλύφθηκε» in the
owner's record is not a ministry receipt.

The screen clears after one minute without interaction, when the tab is hidden, or at «Τέλος». Reading again or
stamping afterwards needs the PIN again. It is still a shared screen: someone looking over the reader's shoulder can
see it. A deactivated or exempt person's record remains available through the owner's individual export (docs/ADMIN.md).

## The first real answers come from one employer's account

What ΕΡΓΑΝΗ answers was measured on real accounts (the forms list, the read services, the schedule rows, the proof
PDF's shape). No `EX_BASE_07` stamp row with hours has been seen yet in the shapes this reader expects for every
employer: an answer in another shape is refused and shown — never read as «no stamp». The 26 October read-only stored-record review found completed monthly pulls with zero stamp rows, while local October cards held filing receipts and proof PDFs. October is not readable until November: those earlier empty reads do not verify a nonempty card answer, split shifts, or overnight shifts. The stored successful receipts confirmed HTTP 200 and string fields `id`, `protocol`, `submitDate` (date shape `DD/MM/YYYY HH:mm`); stored proof PDFs had the PDF header and matching SHA-256. These shapes are exercised with fabricated data in the client and proof tests. No new ministry call or artificial filing was used to close this gap.

## Retired branches keep their login; reactivation has no screen

The desktop owner's Settings page can retire a branch: new cards stop, while history, pending submissions, proof
PDF retrieval and archive reads remain. Its restricted login must stay in the settings. There is no deletion or
reactivation screen, and retiring it here does not close it at the ministry. See [SETTINGS.md](SETTINGS.md).

## Settings changes finish work already in progress

The desktop finishes its current send before reopening the staff service with changed settings. A monthly archive
run already in progress keeps its original connection until it finishes; the next run uses the new settings.

## If the machine that runs it is down, so is the page

The page and its outbox run on one machine. If that machine, its network or its power is down, the page does not load
and the staff use the ministry's CardScanner app until it is back (docs/STAFF-SHEET.md). Monitors (the heartbeat
URLs) and the owner's phone pushes live wherever the employer runs them; if they run on the same machine, they go down
with it.

## The desktop program

- **It starts at sign-in, not at power-on.** The program is the signed-in user's (Windows: the Run entry; Mac: a
  LaunchAgent; Linux: a systemd user service). A reception computer should sign in by itself, or someone signs in each
  morning. One copy per computer: a second user signed in at the same time cannot start a second one (the owner's port is
  taken).
- **Plain HTTP on the practice network.** Phones reach the staff page over the local network without TLS: the practice's
  own WPA2/WPA3 Wi-Fi only, never a guest or public network (the setup refuses a public address). On Windows the
  installer's rules name the program every version runs on (the installed Node.js): port 8880 open on private (and
  domain) networks from the local network only, closed on public ones — so a Wi-Fi that Windows calls «Public» must be made «Private»
  for phones; a page set to another port is not opened for phones.
- **On Windows, Node.js itself is updated by the installer.** Windows' firewall knows a program by its path, so every
  version runs on the installed Node.js whenever it was made for its line (the same major version), and the rules are
  made for it at install. An update within the line runs on the installed Node.js — its Node.js fixes arrive with the
  newer installer, not with the update, and the «Ενημερώσεις» page says so, with the link, whenever a newer one exists.
  CI therefore also runs on the oldest Node.js an installer shipped (packaging/node.json `oldestShipped`). A release on a new Node.js line would run from a new path and be blocked until
  someone allows it — so it is not installed by an update there: the «Ενημερώσεις» page says so and links the page with
  the new installer, which brings it.
- **On Windows, going back across a Node.js line.** If a version brought by an installer of a NEW Node.js line fails its
  probation or later keeps stopping at start, the program goes back to the version before — which cannot run on the new
  line, so it runs on its own copy of the older one, from a path the firewall rules do not name: Windows may ask «allow
  this app?», and phones cannot reach the staff page until someone with an administrator's password allows it for
  private networks (the reception computer keeps working). Rare — a new Node.js line, by installer, and a failure — and
  open. The easy way out is «Ενημέρωση τώρα» (or the next release of the new line): it runs from the installed path
  again. Running that same installer again does not help (a version that failed is not retried by an installer). The
  same holds for an OLDER installer run over a version of a newer line: that version keeps running, on its own copy. Going back within a line runs on the installed Node.js, like everything else — the version gone back to
  then runs on a newer Node.js of its line than it was made for. That is Node.js's promise for its stable parts; the
  program's record store uses `node:sqlite`, which Node.js still marks as in development, so a release that changes
  Node.js is tested with the version before it too, and a failure at start is undone by the probation as always.
- **A downloaded installer is not checked against the project's key.** An update is installed only when it verifies against
  the project's key; an installer the owner downloads from the release page (the first install, or a new Node.js line)
  is run like any download — the release's signed list covers it, but nothing compares the two for the owner.
- **The installer resets the inbound firewall rules for its own program.** At install and uninstall it removes every
  inbound rule for exactly its `node.exe` (and for older per-version copies) before adding its own two — rules Windows
  made by itself, and any an administrator added by hand for that program. Outbound rules are left alone. Its allow rule
  covers private and DOMAIN networks (a domain network is a managed workplace network, never a guest one).
- **Night updates need the computer on at night.** A computer switched off every evening never updates by itself; the
  owner's «Ενημέρωση τώρα» does it. A version that rolled back is not tried again by itself.
- **The rollback covers the probation.** A new version is undone, stores and all, only while it has filed nothing — up to
  the moment its outbox would start. A version that passed and then keeps stopping at start falls back to the previous
  one without the snapshot; if the newer one had changed the stores' schema, the older one refuses them, and the owner
  page says the program did not start. Releases that change the schema are therefore tested on a copy first.
- **No paid code signing.** Windows and macOS warn on the first install (docs/INSTALL-DESKTOP.md shows the clicks). The
  updates are signed with the project's own key and verified by the program; that signature, not the operating system's,
  is what protects an installed copy.

## The accountant export separates local cards from saved ministry read-back

A submission protocol and a ministry read-back interval are different evidence. The accountant ZIP labels every row
and keeps those two sources separate; it does not automatically match them or decide payroll. It reads saved records
only, without refreshing ΕΡΓΑΝΗ. A day without a successful saved read is unknown; a card marked covered elsewhere
still needs that coverage checked. Proof PDFs not yet obtained are identified rather than invented. The ZIP holds
staff identifiers and hours and is not encrypted. Large periods use memory; prefer one month at a time.

## Recovery is a snapshot, with an explicit sending hold

Desktop backups now include both record files, exports and encrypted settings/owner access. Recovery needs the owner password used at the time of that backup. The local settings file still uses the program's existing owner-only file protection; encryption here protects the recovery settings on the backup drive. The SQLite files and exports themselves remain unencrypted and need private storage.

Older backups without `recovery.json` hold records only; they cannot use the guided complete recovery. Keep them, and take a new complete backup while the original computer is available. A forgotten owner password cannot decrypt the recovery settings; the two record files remain readable by a qualified person without that password.

A snapshot cannot recover local cards or proof PDFs written after it. After restoring to an empty data folder, all sending and the staff page remain stopped across restarts until the owner checks old unresolved cards with the accountant and confirms the old computer has stopped. Those old cards are recorded as covered or left to the accountant, not automatically re-sent. A very recent card, or an active late-send decision, must first reach the end of its existing sending window before it accepts that decision. Staff use CardScanner during this check. Do not restore just the two files over an active installation: that bypasses the hold. New-computer steps: [NEW-COMPUTER.md](NEW-COMPUTER.md).

The desktop recovery package is not a Docker backup system or a disk image. Docker operators must back up both volumes and encrypt their settings with their own backup tool, then reconcile pending cards before restarting the sender.

## A connection check cannot prove the restricted permissions

The read-only connection check proves sign-in, an offered card form and (where enabled) one schedule read. It does not prove filing rights, card-only scope, API-only access or the correct branch. The owner checks these in the ministry portal and explicitly records that check on the desktop connection page. Local settings changes ask for a new confirmation; portal-only changes cannot be detected automatically. No artificial card is filed to test permissions.

## Archive status is local, and a page failure remains a failure

The desktop home page shows the last successful daily archive check, the latest failure or zero-stamp warning, incomplete month/branch pairs and missing comparison pages. Older never-read months stay listed even after the ministry's readable window closes; the program cannot fetch them then. A good check over 36 hours old is flagged. The last-success time describes the daily check, which may reuse a complete pull for seven days; it is not the time every ministry row was read again. An export-page failure can coexist with complete stored records and is shown separately. Operational status is rebuilt after recovery; it is not a substitute for the record stores.
