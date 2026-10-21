# Known limits

What is known and not fixed, and why. Stated once, as fact. An entry is removed when it is fixed.

## How ΕΡΓΑΝΗ merges several intervals in one day is unmeasured

A split shift (σπαστό ωράριο) is four declarations against one working day. Whether ΕΡΓΑΝΗ keeps two intervals or
reads one long one from earliest ΕΝΑΡΞΗ to latest ΛΗΞΗ is not settled by the documentation (the current manual and an
older paragraph disagree). Until it is measured, rule 3's bound stands (docs/RULES.md), and a forgotten midday ΛΗΞΗ is
exactly the missed card that could turn a split day into one long one — which is why the «forgot to stamp» alarms check
each declared interval on its own.

## Who is due today comes from last month's schedule

ΕΡΓΑΝΗ answers schedule reads a month late, so the alarms take the same weekday in the latest week it answers. On an
ordinary day of a fixed weekly pattern that is right. It is wrong, and says «check», when: a person is back from
leave since then (missed), a person is newly on leave (a false alarm), a public holiday is not marked closed
(`admin quiet`), or the accountant re-declared the schedule afterwards (not seen).

## A branch with no schedule cannot see a forgotten midday ΛΗΞΗ

On a branch that reads no schedule (`SCHEDULE=none`), «forgot ΛΗΞΗ» fires only for a stint still open at 21:00. A
split day there — ΕΝΑΡΞΗ 09:00, the 14:00 ΛΗΞΗ forgotten, ΕΝΑΡΞΗ 17:00, ΛΗΞΗ 21:00 — raises no alarm, and ΕΡΓΑΝΗ
holds 09:00–21:00. The other way round, a person working past 21:00 there is named as «not stamped out» while still at
work. A branch that reads its schedule catches both at the interval's end + 30′.

## Late sends and a slow ΕΡΓΑΝΗ

The outbox sends cards one after another, oldest first, across all branches. After an outage, if several cards were
approved for late sending and ΕΡΓΑΝΗ is slow (a try can take minutes: timeouts and «too many requests» waits), a card
stamped then waits behind them and may get only one or two tries before its 15 minutes run out; it then goes to the
late-send list like any card that did not get through. A fix must keep one person's cards in order (see «The clock-out
is never delayed», docs/DECISIONS.md) — for example, late sends limited to one per pass, never ahead of an earlier card
of the same person and day. A «fresh cards first» order was tried and dropped: it made a ΛΗΞΗ overtake its own day's
late ΕΝΑΡΞΗ more often.

## The first real answers come from one employer's account

What ΕΡΓΑΝΗ answers was measured on real accounts (the forms list, the read services, the schedule rows, the proof
PDF's shape). No `EX_BASE_07` stamp row with hours has been seen yet in the shapes this reader expects for every
employer: an answer in another shape is refused and shown — never read as «no stamp».

## A branch is never removed

A branch, once in the stores, keeps its login in the settings: its cards are part of the five-year record, and the
service refuses to start with a branch it cannot file for. Closing a branch for good is not yet a command.

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
