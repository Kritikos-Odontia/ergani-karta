# Design decisions

Trade-offs that were weighed and settled, each with what was chosen and why. The code points here by the decision's
name. Changing one is a decision of its own, not a refactor.

## The clock-out is never delayed

A person's ΕΝΑΡΞΗ does not reach ΕΡΓΑΝΗ in time (an outage); someone at the desk chooses «send late, with a reason»;
meanwhile the same person's ΛΗΞΗ is stamped and goes through. Rule 3's bound then stops the ΕΝΑΡΞΗ from being sent at
all: ΕΡΓΑΝΗ holds a ΛΗΞΗ with no ΕΝΑΡΞΗ for that day, the page says «Ενημερώστε τον λογιστή», and the accountant
corrects it.

The alternative — holding the ΛΗΞΗ back until its day's ΕΝΑΡΞΗ is through — keeps the register in order, but while
ΕΡΓΑΝΗ keeps failing the ΛΗΞΗ waits too and can pass its own 15 minutes: a second late card. **Chosen: a ΛΗΞΗ never
waits behind its day's pending ΕΝΑΡΞΗ;** the rare case goes to the accountant. If ΕΡΓΑΝΗ's handling of several
intervals in a day is ever measured to make an ΕΝΑΡΞΗ after a ΛΗΞΗ harmless, rule 3's bound — and this question — go
away.

## Fresh cards keep their window while a late backlog drains

An unrelated old card approved for late sending must not consume a newly stamped card's automatic sending window.
The outbox therefore re-reads the queue after each attempt. Among due cards it takes a fresh card first, promoting
any earlier due cards of the same person and working day ahead of it, across all branches. Each card is tried at most
once per pass. A failed earlier card's retry gap never holds up a ΛΗΞΗ; rule 3 still blocks an ΕΝΑΡΞΗ once a later card
may have reached ΕΡΓΑΝΗ. Without a fresh card needing those earlier cards, at most one late card is sent in a pass.
The next pass continues the durable backlog, also after a restart. There is still only one filing in flight per store.

## Personal history carries no authority to stamp

The staff page's «Οι κινήσεις μου» uses the employee's own PIN check, with the same attempt limits as stamping. The
checked person's identity and enrolled device are held in a short-lived ticket; the browser cannot select a different
person's history. Opening history consumes the stamp ticket and returns history-only tickets for paging and filtering.
The view sends no ΑΦΜ, ministry error prose or other decision maker's name. Reading never writes a card or decision.
On the shared screen, «Τέλος», a hidden tab or one minute without interaction clears it; a new visit starts with a PIN.

## One arrival, one card

While a card is still being sent, nothing tells staff to stamp it again elsewhere (on the ministry's CardScanner app,
say): ΕΡΓΑΝΗ may already hold the first send with its answer lost, and how it reads two ΕΝΑΡΞΗ for one arrival is
unmeasured — her recorded arrival could become the later time. An unconfirmed card keeps retrying; past its 15
minutes it goes to the late-send list with a reason chosen at the desk. CardScanner stays the fallback only for a page
that cannot take a stamp at all (it says the server is not answering, or does not open).

## The 15-minute queue opens at minute 14

The outbox sends nothing after minute 14 (`LAST_SEND_MS`) and the card goes to a person at once. Whether ΕΡΓΑΝΗ
counts a card as late is decided by its clock, not ours; a minute of margin for the two clocks is better than a card
sitting in limbo. The page never says «late» before the statutory 15 minutes have passed.

## Alarms name the person

A push to the owner's phone says WHO did not stamp, or whose card did not go through — the owner needs to know who is
having a problem. So pushes go only to a server the employer controls, with logins (never a public ntfy.sh topic),
and never carry an ΑΦΜ (`withoutAfm`). The reception screen never shows an ΑΦΜ either: a ministry sentence that quotes
one is shown with the nine digits blanked; the record keeps it verbatim.

**The easy mode is the exception, by construction.** For a practice without its own ntfy server, pushes may go to the
public ntfy.sh — but then they carry no name at all: the easy sender never reads the alarm's text, it sends one of a
fixed set of sentences chosen by the alarm's kind («…δείτε τη σελίδα στο ιατρείο») under a fixed title, to a long random
topic the owner can replace. A push that names a person is refused for ntfy.sh in the settings and again when it sends,
and no push follows a redirect (a redirect could carry it elsewhere). What ntfy.sh still sees is when each push is sent
and from which internet address — in a practice with one or two staff, an alarm's time can point to one person; said
in docs/NOTIFICATIONS.md, with the own server as the way out.

## The desk says when the owner's phone is not getting the alarms

While an alarm is owed a push and its latest push failed (the push server down, its login lost), the reception page
shows an amber line so someone tells the owner. Pushes are never given up while their alarm still holds — retried
every minute, then every ten. The list of alarms owed a push and the list the pass pushes come from one function, so
they cannot drift apart.

## A PIN reset is logged as the employer's

The owner can issue a new one-time PIN (a forgotten PIN, a lock); whoever holds it then chooses the new PIN. The reset
is logged as the employer's in the person's record. This means that across a reset, the holder of the one-time PIN
could stamp as that person — accepted, because the alternative (resets only in the person's presence) would block a
person who forgot their PIN until the owner is at the desk, and the log shows who reset what, when.

## Who is due today is read from ΕΡΓΑΝΗ's own schedule — a month late

ΕΡΓΑΝΗ answers schedule reads only for the previous month and earlier. The «not stamped in» alarm therefore takes the
same weekday in the latest week ΕΡΓΑΝΗ will answer as today's (right for a fixed weekly pattern). Its limits are
stated in [KNOWN-LIMITS.md](KNOWN-LIMITS.md). A branch whose days are planned week by week can switch the reading off
(`STAMP_BRANCH_<n>_SCHEDULE=none`): its «not stamped out» alarm still works from her open ΕΝΑΡΞΗ.

## Never read a month ΕΡΓΑΝΗ may have deleted

ΕΡΓΑΝΗ keeps card data six months, and what it answers for a day it has deleted is unmeasured: an empty answer would
be recorded as «no stamp» on a day someone worked, or mark every stamp held for it «no longer answered» — for good.
So the archive never pulls a month six or more months back, and re-reads a month five back only if it was never held
complete. The daily run gives five months of slack; a month left for longer is one ΕΡΓΑΝΗ has largely deleted anyway.

## Nothing with a person's data inside a code folder

The record stores and every exported page hold ΑΦΜ and working hours. A file in a git working copy is one `git add`
away from a pushed remote, so the code refuses to create one inside **any** code folder on the machine (a folder with
a `.git` entry, or below one), judged on where the path really leads. `.gitignore` is a backstop, not the control.

## One store per employer, every branch in it

Rule 3's bound and the working day of a ΛΗΞΗ after midnight are questions about the PERSON's day, wherever she stamped.
A store per branch could not answer them: an ΕΝΑΡΞΗ at one branch and the ΛΗΞΗ at another would each sit in a store
that cannot see the other, and an earlier ΕΝΑΡΞΗ could be sent late after the later ΛΗΞΗ was filed. So one store holds
every branch, each card carries its branch, staff and PINs are the employer's, and a card is always filed with its own
branch's login. The outbox sends one card at a time across all branches, so the bound's look and another branch's send
never run at once. And only one outbox runs per store: the stamping service takes a lock beside the store at start,
holds it for as long as it lives, and refuses to start without it (`src/stamp/store-lock.ts`), so a second
`ergani stamp` on the same store never starts.

## One restricted login per branch

A Χρήστης Παραρτήματος acts for its own branch (the ministry's CardScanner guide: «…όλες τις ενέργειες/δηλώσεις που
αφορούν το συγκεκριμένο παράρτημα»), and no read can prove filing rights for another branch. So every branch has its
own login, and the same login serves that branch's stamping and its monthly archive reads.

## A restored snapshot never resumes old sends automatically

A card pending in yesterday's backup may have reached ΕΡΓΑΝΗ afterwards. Starting that old outbox immediately would re-send it without the owner noticing. Complete desktop recovery therefore restores both record files unchanged into a fresh data folder and persists a hold before any files are copied. No staff page, archive or sender starts until the owner checks every old unresolved card with the accountant, records it as covered/left to the accountant, and confirms that the old installation has stopped. New cards then use the ordinary path. The record stays append-only; reconciliation adds decisions, never rewrites attempts or cards.

The settings and owner state travel in an AES-256-GCM envelope, with integrity hashes for both record files. Its key is domain-separated from the existing owner's scrypt verifier; only that verifier's salt is public, and the verifier itself is inside the encrypted state. This permits automatic daily backups without retaining the owner's clear password and permits recovery on a new machine with the owner password used for that snapshot. The live settings file keeps its existing owner-only protection. Record files and exports remain private files, not encrypted archives. No operating-system secret store is needed for recovery across computers.

## A read-only connection check leaves restricted permissions to the owner

Sign-in and a form in `Lookup/Submissions` do not demonstrate permission to submit it, exclusion of other forms, API-only access or the correct branch. No fake card is filed to test those claims. The check says exactly which reads succeeded and asks the owner to reload each user in the ministry portal and explicitly confirm its restrictions. The desktop records when the owner confirmed the current settings; a settings change invalidates that confirmation. A portal-only change cannot be detected by this program.
