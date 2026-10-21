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
topic the owner can replace. A push that names a person is refused for ntfy.sh in the settings and again when it sends.

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
