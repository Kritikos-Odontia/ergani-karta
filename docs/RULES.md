# The rules this software keeps

> **What this is.** Software that files **ψηφιακή κάρτα εργασίας** ΕΝΑΡΞΗ/ΛΗΞΗ declarations to **ΕΡΓΑΝΗ ΙΙ** for one
> employer — any number of branches — and keeps the five-year record. A defect here is not a bad screen: it is **a
> false or missing declaration to a government register about a named person's working time**, priced at
> €3,000–€10,500 per employee. So the order of priorities, when two pull apart, is
> **correctness > reliability > simplicity > features.**
>
> The code cites these rules by number (`docs/RULES.md rule 3`). A rule without its reason gets argued away by the
> next change, so each carries its reason. Design decisions that settled a trade-off are in [DECISIONS.md](DECISIONS.md);
> what is known and not fixed is in [KNOWN-LIMITS.md](KNOWN-LIMITS.md).

## 1. ⛔ The employee acts. The employer never stamps for them.

The ministry's interpretive circular prohibits, in terms, «Η έναρξη ή/και η λήξη της ημερήσιας χρονοπαρουσίας
**μονομερώς από τον εργοδότη**». The obvious convenience — the owner clocking an assistant in — is an unlawful act.

- There is **no path that creates a card attributed to someone else**. A card is written in one place
  (`src/stamp/capture.ts`), reached only through the person's own PIN (`VerifiedPerson`), and a test fails if any other
  file writes one.
- The PIN is the person's own: the owner hands over a one-time PIN, the person chooses their own before the first card,
  and from then on nobody else knows it.
- A correction is a **re-filing of what actually happened**, attributed to the human who made it and carrying a
  reason — never a silent insert. A change that adds an "on behalf of" writer is refused.

## 2. ⛔ The local store is the system of record — not a cache.

ΕΡΓΑΝΗ keeps card data **six months**; the employer must keep it **five years** (official guidance has also said ten —
the store never deletes, so either is met), with **each employee able to see their own** (ΥΑ 113169/2023). That access
is a legal requirement, not a feature (`ergani admin history`, `ergani export employee`).

- **Durable before dispatch:** a card is committed in the request that captures it, **before any network call**. A
  card is never lost to a failed call.
- **Append-only, by the database itself:** every table of the record refuses DELETE and UPDATE with a trigger. No TTL,
  no purge, no "cleanup" command, no down migration. A backup is insurance, not the record.
- ⛔ Nothing that holds a person's data is ever written inside a code folder (`src/code-folders.ts`): one `git add`
  away from a pushed remote is too close.

## 3. ⭐ Retry is safe — with one bound.

Card events are **idempotent-by-latest** («θεωρείται ως έγκυρο το περιεχόμενο της πιο πρόσφατης δήλωσης») and there
is **no cancel path**. A lost answer is simply asked again; it cannot mint a duplicate legal document. So there is no
fiscal-style "rejected vs unknown" machinery here, deliberately.

⚠ **The one bound,** until measurement settles how ΕΡΓΑΝΗ merges several intervals in a day: **never send an ΕΝΑΡΞΗ
after a later card of the same person and working day may have been filed** — at any branch of the employer. Such an
ΕΝΑΡΞΗ goes to a person, and the only choice is «covered» (the accountant corrects it).

## 4. ⚠⚠ The 15-minute wall is a hard stop, not a backoff parameter.

Each event must reach ΕΡΓΑΝΗ within **15 minutes** (ΥΑ 49758/2022). Past it the submission is permanently
«Εκπρόθεσμη» and needs a **human** to choose a reason — it cannot be auto-retried into compliance.

The outbox retries aggressively **inside** the window (at once, +10 s, +30 s, +60 s, then every minute), sends nothing
after minute 14 (enforced at the wire, `src/stamp/deadline.ts`), and hands the card to the human queue on the page.
An outbox that kept quietly retrying past the wall would be a defect, not resilience.

## 5. ⚠⚠ Force majeure is two notifications by the employer — not a field.

The employer must notify the οικεία Επιθεώρηση Εργασίας «**αμέσως μόλις προκύψει και μόλις λήξει**» any condition
that prevents transmission. **Choosing a late-filing reason code does not discharge it.** The page says so, in Greek,
on screen, naming both notifications (and the Επιθεώρηση's address, when the setup was given it).

⇒ Being up during opening hours is a **compliance property**, not a comfort: the services restart by themselves, and
the page turns red when it cannot reach its server.

## 6. ⚠ Every person stamps unless explicitly, and with a reason, exempted.

Dentists are exempt («εξαιρούνται οι ιατροί και οι οδοντίατροι», ΦΕΚ Β' 3051/02.06.2026). Assistants, secretaries
and cleaning staff are **in**. The default is **must stamp**, because a missed card is €10,500 and over-collection is
only a data-minimisation problem. An exemption is set deliberately, with a recorded reason — **never inferred from a
job title**.

## 7. ⛔ The ΕΡΓΑΝΗ login: restricted, one seam, never logged.

- Each branch uses a **restricted Χρήστης Παραρτήματος** that can file only «Δήλωση Έναρξης / Λήξης Εργασίας» and
  only through the API — **never the employer's master codes** ([ERGANI-USER.md](ERGANI-USER.md)).
  ⛔ **The safe default is the unsafe one:** a Παράρτημα user with *no* form selected can submit **all** forms,
  hirings and dismissals included.
- The password is held in a `Secret` (`src/config.ts`) that prints as `[redacted]` everywhere a value escapes, and is
  exposed at exactly one place: the client's sign-in request. Never logged, never echoed, never in an error message.
- ⚠ The ΕΡΓΑΝΗ password is 8–12 characters, static and non-rotatable — weak by construction. That is the ministry's
  design. The settings file that holds it is written 0600 and must stay on the machine that runs the service.

## 8. ⚠ Cache the token; keep the ministry's words verbatim.

- Token lifetime is about three hours. The ministry's own guide (Παράρτημα ΙΙ §4, «Λανθασμένη χρήση») names a full
  sign-in on every call as anti-pattern #1. The client signs in once, refreshes on expiry, and waits out a 429.
- Errors are **HTTP 400 with a free-text Greek sentence and no code.** The sentence is kept verbatim and shown to a
  person. ⛔ No classifier is built over prose the ministry can change without notice.

## 9. ⛔⛔ No real person is ever a test fixture.

Every filing is a legally binding statement about a **named real person's** working time.

- Tests use **fabricated ΑΦΜ and names against a local fake** (`test/fake/ergani-fake.ts`) and never reach any ΕΡΓΑΝΗ
  host — trial included. A runtime fence (`test/setup.ts`) refuses every ΕΡΓΑΝΗ address inside the test run.
  ⛔ Never weaken the fence to prove a test can fail: mutate the code or its input instead.
- The first real card is a **true** declaration about a **real** arrival, on a real shift ([INSTALL.md](INSTALL.md),
  «Η πρώτη πραγματική κάρτα»).

## Reach

The page names staff and takes their PINs. It is published **only on a private address** — the practice's own network,
or a private overlay network such as Tailscale — and only an **enrolled device** sees anything on it. `ergani setup`
refuses a public address; Docker Compose publishes the one address setup checked.

## Out of scope — these are refusals, not preferences

| ⛔ Out of scope | Why |
|---|---|
| Payroll, ΑΠΔ, hirings, dismissals | The restricted login exists precisely so the software cannot reach them. |
| Filing ΨΟΧΕ / schedule declarations | The accountant's. The software may *read* schedules; it never files them. |
| Any clinical or patient data | This holds staff working time only — permanently. |
| A portal scraper | Same-day read-back is portal-only; scraping needs the master codes and a far worse privacy posture. |
| Several employers in one installation | Every Usertype is an *employer* identity, and one store holds one employer's record: a second employer is a second installation, with its own logins, stores and port. |
