-- SPDX-License-Identifier: EUPL-1.2
-- 001 — STAMPING, for ONE employer and every branch it has: the people who stamp, the devices allowed to show a
-- branch's page, every card they stamped, every request sent to file it, every attempt and how it ended, every human
-- decision about it, and the proof ΕΡΓΑΝΗ returned.
--
-- ⛔⛔ THE CARDS AND EVERYTHING SAID ABOUT THEM ARE NEVER DELETED OR CHANGED (docs/RULES.md rule 2). This store is the
-- system of record of what was filed: ΕΡΓΑΝΗ keeps card data six months, the employer owes five (retain ten). A backup
-- is insurance, not the record. `punches`, `dispatches`, `attempts`, `decisions`, `evidence` and `employee_events`
-- refuse DELETE and UPDATE below; the store opens with recursive_triggers ON, so an INSERT OR REPLACE is refused too.
-- No TTL, no purge, no down migration.
--
-- ⓘ Two tables DO change, and only as the triggers allow: `employees` (the current PIN, the lock, whether the person
-- stamps — every such change is logged in `employee_events` by the code that makes it; the ΑΦΜ never changes) and
-- `devices` / `enrollments` (a device is revoked, a link is used). None is ever deleted.

-- Which employer this store belongs to: written once at `init`, refused if it ever disagrees with the configuration
-- the service starts with — one store, one employer, one realm. Trial filings («ΑΚΥΡΟ») mixed into a real record, or
-- one practice's staff in another's, would stand there for five years.
CREATE TABLE instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The employer's short name on the box (lower-case letters, digits, dashes): it names the store, the page's cookie.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 31 AND name NOT GLOB '*[^a-z0-9-]*' AND name GLOB '[a-z]*'),
  realm TEXT NOT NULL CHECK (realm IN ('production', 'trial', 'local')),
  employer_afm TEXT NOT NULL CHECK (length(employer_afm) = 9 AND employer_afm NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL
);

-- The employer's branches (παραρτήματα) this store holds cards for: added on purpose, once each, never removed.
-- `code` is f_aa as Card_v1.xsd has it (1–5 digits, a string), in plain decimal — `0`, `1`, never `01`: ΕΡΓΑΝΗ's
-- read services take it as an integer, and two spellings of one branch would split its record in two.
CREATE TABLE branches (
  code TEXT PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 5 AND code NOT GLOB '*[^0-9]*' AND (code = '0' OR code NOT GLOB '0*')),
  added_at TEXT NOT NULL
);

-- The people who stamp, at any branch of the employer. ⚠ must_stamp DEFAULTS TO 1 (docs/RULES.md rule 6): a missed
-- card is €10,500, over-collection is a data-minimisation problem. An exemption (a dentist) is explicit and carries
-- its reason; it is never inferred.
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  -- Which real person a card is about. A string of nine digits. Never changed (trigger below): a wrong ΑΦΜ is a
  -- different person — deactivate this row and add the right one.
  afm TEXT NOT NULL UNIQUE CHECK (length(afm) = 9 AND afm NOT GLOB '*[^0-9]*'),
  -- As ΕΡΓΑΝΗ holds them, and as every card names them (Card_v1.xsd: ≤ 50 and ≤ 30).
  surname TEXT NOT NULL CHECK (length(surname) BETWEEN 1 AND 50),
  first_name TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 30),
  -- What the reception page and the owner's phone call the person, as the owner sets it.
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  must_stamp INTEGER NOT NULL DEFAULT 1 CHECK (must_stamp IN (0, 1)),
  exempt_reason TEXT CHECK (exempt_reason IS NULL OR length(trim(exempt_reason)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- scrypt, never the PIN. NULL for a person who does not stamp. One PIN for every branch of the employer.
  pin_hash TEXT,
  -- 1 while the PIN is the one-time PIN the owner handed over: the person must choose their own before stamping.
  pin_is_temporary INTEGER NOT NULL DEFAULT 1 CHECK (pin_is_temporary IN (0, 1)),
  failed_pins INTEGER NOT NULL DEFAULT 0 CHECK (failed_pins >= 0),
  locked_until_ms INTEGER,
  CHECK ((must_stamp = 1) = (exempt_reason IS NULL)),
  CHECK (must_stamp = 0 OR pin_hash IS NOT NULL)
);

-- Every change to a person, with who made it: added, exempted (and why), included, a PIN issued or chosen, renamed,
-- deactivated, reactivated, locked, unlocked.
CREATE TABLE employee_events (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'exempted', 'included', 'pin_issued', 'pin_chosen', 'renamed',
                                     'deactivated', 'reactivated', 'locked', 'unlocked')),
  detail TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL CHECK (length(by) > 0)
);

-- The computers allowed to show a branch's page. The cookie holds a random token; only its SHA-256 is kept here.
-- A device belongs to ONE branch: every card stamped on it is that branch's card (its f_aa).
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL REFERENCES branches (code),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT
);

-- One-time enrolment links, created by the owner on the server, each for one branch. Only the SHA-256 of the token is kept.
CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL REFERENCES branches (code),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  used_at TEXT,
  device_id INTEGER REFERENCES devices (id)
);

-- ⛔⛔ THE CARDS. One row per ΕΝΑΡΞΗ or ΛΗΞΗ a person made at a branch's page, with their PIN, on an enrolled
-- device — written in the request that captured it, BEFORE any network call (docs/RULES.md rule 2). The person's name
-- and ΑΦΜ are copied in as they were filed, so the row stands on its own for five years.
-- ⛔ There is exactly one writer (src/stamp/capture.ts), reached only through a checked PIN: no admin path creates a
-- card attributed to someone else (docs/RULES.md rule 1).
CREATE TABLE punches (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  afm TEXT NOT NULL CHECK (length(afm) = 9 AND afm NOT GLOB '*[^0-9]*'),
  surname TEXT NOT NULL,
  first_name TEXT NOT NULL,
  -- The branch it was stamped at (the device's): f_aa of its filing, and the login it is filed with.
  branch TEXT NOT NULL REFERENCES branches (code),
  -- Card_v1.xsd: '0' ΕΙΣΟΔΟΣ (ΕΝΑΡΞΗ), '1' ΕΞΟΔΟΣ (ΛΗΞΗ).
  f_type TEXT NOT NULL CHECK (f_type IN ('0', '1')),
  -- The working day the card belongs to, 'YYYY-MM-DD' (a ΛΗΞΗ after midnight keeps its ΕΝΑΡΞΗ's day — at any branch).
  reference_date TEXT NOT NULL CHECK (reference_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  -- f_date exactly as sent: the server's clock at «Επιβεβαίωση», Athens time with its offset.
  f_date TEXT NOT NULL,
  -- The same instant, epoch ms: the 15-minute wall is counted from it.
  event_ms INTEGER NOT NULL,
  device_id INTEGER NOT NULL REFERENCES devices (id),
  created_at TEXT NOT NULL
);
CREATE INDEX punches_by_person_day ON punches (employee_id, reference_date, event_ms);
CREATE INDEX punches_by_day ON punches (reference_date, event_ms);

-- A human's decision about a card that did not reach ΕΡΓΑΝΗ in time (the human queue, docs/RULES.md rules 4 and 5):
-- file it late with one of the ministry's three reasons, or record that it was covered another way (stamped with
-- CardScanner, or left to the accountant). Who decided, and on which device, is kept.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  punch_id INTEGER NOT NULL REFERENCES punches (id),
  kind TEXT NOT NULL CHECK (kind IN ('file_late', 'covered')),
  -- WorkCardDelayReason: 001 ΗΛΕΚΤΡΟΔΟΤΗΣΗ/ΤΗΛΕΠΙΚΟΙΝΩΝΙΕΣ · 002 ΣΥΣΤΗΜΑΤΑ ΕΡΓΟΔΟΤΗ · 003 ΣΥΝΔΕΣΗ ΜΕ ΠΣ ΕΡΓΑΝΗ.
  f_aitiologia TEXT CHECK (f_aitiologia IS NULL OR f_aitiologia IN ('001', '002', '003')),
  by_employee_id INTEGER REFERENCES employees (id),
  by_label TEXT NOT NULL CHECK (length(by_label) > 0),
  device_id INTEGER REFERENCES devices (id),
  at_ms INTEGER NOT NULL,
  CHECK ((kind = 'file_late') = (f_aitiologia IS NOT NULL))
);

-- A SEND IS RECORDED BEFORE IT LEAVES. One row per request the outbox is about to send for a card, written before the
-- network call; the matching `attempts` row records how it ended. A dispatch with no ending is a send whose fate is
-- unknown — the service died between ΕΡΓΑΝΗ taking it and our writing that down — so for rule 3's bound it is a card
-- that MAY be at ΕΡΓΑΝΗ (docs/RULES.md rule 3: never an ΕΝΑΡΞΗ after a later card of the same day was filed).
CREATE TABLE dispatches (
  id INTEGER PRIMARY KEY,
  punch_id INTEGER NOT NULL REFERENCES punches (id),
  at_ms INTEGER NOT NULL
);
CREATE INDEX dispatches_by_punch ON dispatches (punch_id);

-- Every attempt to file a card, as it ended. ⚠ The ministry's sentence is kept VERBATIM (docs/RULES.md rule 8).
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  punch_id INTEGER NOT NULL REFERENCES punches (id),
  -- Set when the attempt carries out a human's «file late» decision.
  decision_id INTEGER REFERENCES decisions (id),
  started_ms INTEGER NOT NULL,
  finished_ms INTEGER NOT NULL,
  f_aitiologia TEXT NOT NULL CHECK (f_aitiologia IN ('', '001', '002', '003')),
  -- 'filed': ΕΡΓΑΝΗ returned a receipt. 'refused': ΕΡΓΑΝΗ answered HTTP 400. 'failed': anything else — no answer,
  -- a timeout, the wall, another status, or a 200 without a recognisable receipt.
  outcome TEXT NOT NULL CHECK (outcome IN ('filed', 'refused', 'failed')),
  http_status INTEGER,
  message TEXT,
  -- The receipt: ΑΡΙΘΜΟΣ ΠΡΩΤΟΚΟΛΛΟΥ, ΕΡΓΑΝΗ's id, its submit date (DD/MM/YYYY HH:mm), and the body as received.
  protocol TEXT,
  ergani_id TEXT,
  submit_date TEXT,
  receipt TEXT,
  CHECK ((outcome = 'filed') = (protocol IS NOT NULL))
);
CREATE INDEX attempts_by_punch ON attempts (punch_id, finished_ms);

-- The proof PDF of a filed card (guide §2.1.8), or why fetching it failed. One row per fetch.
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  at_ms INTEGER NOT NULL,
  pdf BLOB,
  sha256 TEXT,
  error TEXT,
  CHECK ((pdf IS NULL) <> (error IS NULL)),
  CHECK ((pdf IS NULL) = (sha256 IS NULL))
);
CREATE INDEX evidence_by_attempt ON evidence (attempt_id);

-- ⛔ The database refuses to lose the record, whatever the code above it does.
CREATE TRIGGER instance_fixed_update BEFORE UPDATE ON instance
BEGIN SELECT RAISE(ABORT, 'the store belongs to one employer: instance is never changed'); END;
CREATE TRIGGER instance_fixed_delete BEFORE DELETE ON instance
BEGIN SELECT RAISE(ABORT, 'the store belongs to one employer: instance is never deleted'); END;

CREATE TRIGGER branches_fixed_update BEFORE UPDATE ON branches
BEGIN SELECT RAISE(ABORT, 'a branch is never changed'); END;
CREATE TRIGGER branches_fixed_delete BEFORE DELETE ON branches
BEGIN SELECT RAISE(ABORT, 'a branch is never removed: its cards are part of the record'); END;

CREATE TRIGGER employees_never_deleted BEFORE DELETE ON employees
BEGIN SELECT RAISE(ABORT, 'staff are never deleted: deactivate instead'); END;
CREATE TRIGGER employees_afm_fixed BEFORE UPDATE OF afm ON employees
BEGIN SELECT RAISE(ABORT, 'an ΑΦΜ is never changed: a different ΑΦΜ is a different person'); END;

CREATE TRIGGER employee_events_append_only_delete BEFORE DELETE ON employee_events
BEGIN SELECT RAISE(ABORT, 'the record is append-only: employee_events rows are never deleted'); END;
CREATE TRIGGER employee_events_append_only_update BEFORE UPDATE ON employee_events
BEGIN SELECT RAISE(ABORT, 'the record is append-only: employee_events rows are never changed'); END;

CREATE TRIGGER devices_never_deleted BEFORE DELETE ON devices
BEGIN SELECT RAISE(ABORT, 'devices are never deleted: revoke instead'); END;
CREATE TRIGGER devices_only_revoked BEFORE UPDATE ON devices
WHEN NEW.id IS NOT OLD.id OR NEW.branch IS NOT OLD.branch OR NEW.label IS NOT OLD.label
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.enrolled_at IS NOT OLD.enrolled_at OR OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a device can only be revoked, once'); END;

CREATE TRIGGER enrollments_never_deleted BEFORE DELETE ON enrollments
BEGIN SELECT RAISE(ABORT, 'enrolment links are never deleted'); END;
CREATE TRIGGER enrollments_only_used BEFORE UPDATE ON enrollments
WHEN NEW.id IS NOT OLD.id OR NEW.branch IS NOT OLD.branch OR NEW.label IS NOT OLD.label
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_ms IS NOT OLD.expires_ms
  OR OLD.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'an enrolment link can only be used, once'); END;

CREATE TRIGGER punches_append_only_delete BEFORE DELETE ON punches
BEGIN SELECT RAISE(ABORT, 'the record is append-only: punches rows are never deleted'); END;
CREATE TRIGGER punches_append_only_update BEFORE UPDATE ON punches
BEGIN SELECT RAISE(ABORT, 'the record is append-only: punches rows are never changed'); END;

CREATE TRIGGER decisions_append_only_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'the record is append-only: decisions rows are never deleted'); END;
CREATE TRIGGER decisions_append_only_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'the record is append-only: decisions rows are never changed'); END;

CREATE TRIGGER dispatches_append_only_delete BEFORE DELETE ON dispatches
BEGIN SELECT RAISE(ABORT, 'the record is append-only: dispatches rows are never deleted'); END;
CREATE TRIGGER dispatches_append_only_update BEFORE UPDATE ON dispatches
BEGIN SELECT RAISE(ABORT, 'the record is append-only: dispatches rows are never changed'); END;

CREATE TRIGGER attempts_append_only_delete BEFORE DELETE ON attempts
BEGIN SELECT RAISE(ABORT, 'the record is append-only: attempts rows are never deleted'); END;
CREATE TRIGGER attempts_append_only_update BEFORE UPDATE ON attempts
BEGIN SELECT RAISE(ABORT, 'the record is append-only: attempts rows are never changed'); END;

CREATE TRIGGER evidence_append_only_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'the record is append-only: evidence rows are never deleted'); END;
CREATE TRIGGER evidence_append_only_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'the record is append-only: evidence rows are never changed'); END;
