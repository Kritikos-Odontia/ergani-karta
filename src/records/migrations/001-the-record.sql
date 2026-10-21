-- SPDX-License-Identifier: EUPL-1.2
-- 001 — THE RECORD: the employer's five-year, per-employee record of working time, as ΕΡΓΑΝΗ holds it — for every
-- branch of ONE employer.
--
-- ΥΑ 113169/2023: the employer keeps card data FIVE years, with each employee able to see their own
-- (failing to retain is €4,000). ΕΡΓΑΝΗ keeps six months. These tables are that record.
--
-- ⛔⛔ NOTHING HERE IS EVER DELETED OR CHANGED. Every table is append-only, and the database itself
-- refuses a DELETE or an UPDATE (the triggers at the end). The live tables ARE the five-year record:
-- a backup is insurance (and usually pruned within a year), not the record.
-- ⛔ No TTL, no purge job, no lifecycle tier, no "cleanup" command, and no down migration. Five staff
-- make on the order of 1,500 stamp rows a year. A later session must not add one.
--
-- ⭐ HOW A RE-PULL CORRECTS WITHOUT DUPLICATING OR DROPPING. A row's content is stored ONCE (the UNIQUE
-- constraints); every pull that reads it adds a SIGHTING. So:
--   · the same month read twice adds no stamp or schedule row, only a second sighting of each;
--   · a row the ministry has CHANGED arrives as a new row, and the old one is kept;
--   · a row the ministry no longer answers is kept, and is recognisable because the latest successful
--     read of its day did not sight it. What we hold and what the ministry now says are both here.

-- Which employer this record belongs to: written once, when the store is created, and refused if it ever disagrees
-- with the configuration a pull runs with. ⓘ A read carries no employer — the signed-in user decides whose rows answer —
-- so this is what keeps one practice's months out of another's five-year record.
CREATE TABLE employer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  afm TEXT NOT NULL CHECK (length(afm) = 9 AND afm NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL
);

-- One run of the monthly pull, for ONE branch: when, which month, how it ended, and how many rows of each.
CREATE TABLE pulls (
  id INTEGER PRIMARY KEY,
  -- 'YYYY-MM', the month read.
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'),
  -- Which ΕΡΓΑΝΗ was read. A store holds ONE realm: trial answers («ΑΚΥΡΟ») mixed into the real record
  -- would stand beside real stamps, and would make every real row read as no longer answered.
  realm TEXT NOT NULL CHECK (realm IN ('production', 'trial', 'local')),
  -- PararthmaAa as sent: f_aa as the integer, in decimal digits.
  branch TEXT NOT NULL CHECK (branch <> '' AND branch NOT GLOB '*[^0-9]*'),
  -- ISO-8601 instants, from the client's clock.
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  -- 'complete': every day of the month read, both services. 'incomplete': the walk reached the end, but
  -- at least one answer was not recognised. 'stopped': a read failed and its service's walk stopped there.
  outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'incomplete', 'stopped')),
  -- Rows the answers held, summed over the days read. ⭐ Zero stamp rows in a complete month is a
  -- finding, and it is recorded here like any other count.
  stamp_rows INTEGER NOT NULL CHECK (stamp_rows >= 0),
  schedule_rows INTEGER NOT NULL CHECK (schedule_rows >= 0),
  -- Rows this pull stored for the first time.
  new_stamp_rows INTEGER NOT NULL CHECK (new_stamp_rows >= 0),
  new_schedule_rows INTEGER NOT NULL CHECK (new_schedule_rows >= 0),
  -- Rows held for a day this pull read successfully, which that day's answer no longer contained.
  stamps_no_longer_answered INTEGER NOT NULL CHECK (stamps_no_longer_answered >= 0),
  schedule_no_longer_answered INTEGER NOT NULL CHECK (schedule_no_longer_answered >= 0)
);

-- What the service answered, per service per day: a row count, or the error exactly as it was raised.
CREATE TABLE day_reads (
  pull_id INTEGER NOT NULL REFERENCES pulls (id),
  service TEXT NOT NULL CHECK (service IN ('EX_BASE_07', 'EX_BASE_08')),
  -- 'YYYY-MM-DD', the reference date asked for.
  day TEXT NOT NULL,
  rows INTEGER CHECK (rows >= 0),
  error TEXT,
  CHECK ((rows IS NULL) <> (error IS NULL)),
  PRIMARY KEY (pull_id, service, day)
);

-- EX_BASE_07 — ΗΜΕΡΟΛΟΓΙΟ ΠΡΑΓΜΑΤΙΚΗΣ ΑΠΑΣΧΟΛΗΣΗΣ: what an employee actually stamped.
CREATE TABLE stamps (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL,
  -- The reference date the pull asked about, 'YYYY-MM-DD'.
  day TEXT NOT NULL,
  -- A string of nine digits: as a number, a leading zero would vanish.
  afm TEXT NOT NULL CHECK (length(afm) = 9 AND afm NOT GLOB '*[^0-9]*'),
  -- Date, HourFrom and HourTo exactly as ΕΡΓΑΝΗ sent them: their formats are unmeasured.
  date TEXT NOT NULL,
  hour_from TEXT NOT NULL,
  hour_to TEXT NOT NULL,
  -- IsEndDateDifferentThanDate: the exit fell on the calendar day after `date` (a night shift).
  ends_next_day INTEGER NOT NULL CHECK (ends_next_day IN (0, 1)),
  -- The pull that first stored this row.
  first_pull_id INTEGER NOT NULL REFERENCES pulls (id),
  UNIQUE (branch, day, afm, date, hour_from, hour_to, ends_next_day)
);

-- Which pull read which stamp row, and how many times that day's answer listed it.
CREATE TABLE stamp_sightings (
  stamp_id INTEGER NOT NULL REFERENCES stamps (id),
  pull_id INTEGER NOT NULL REFERENCES pulls (id),
  copies INTEGER NOT NULL CHECK (copies >= 1),
  PRIMARY KEY (stamp_id, pull_id)
);

-- EX_BASE_08 — ΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ ΨΟΧΕ: the declared schedule and leave, per employee per day. The
-- comparison (src/export/) reads these beside the stamps. A row with no working hours (leave) is normal.
CREATE TABLE schedule (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL,
  day TEXT NOT NULL,
  afm TEXT NOT NULL CHECK (length(afm) = 9 AND afm NOT GLOB '*[^0-9]*'),
  -- Every value exactly as ΕΡΓΑΝΗ sent it.
  type TEXT NOT NULL,
  hour_from TEXT NOT NULL,
  hour_to TEXT NOT NULL,
  break_minutes TEXT NOT NULL,
  break_in_work TEXT NOT NULL,
  extra TEXT NOT NULL,
  first_pull_id INTEGER NOT NULL REFERENCES pulls (id),
  UNIQUE (branch, day, afm, type, hour_from, hour_to, break_minutes, break_in_work, extra)
);

CREATE TABLE schedule_sightings (
  schedule_id INTEGER NOT NULL REFERENCES schedule (id),
  pull_id INTEGER NOT NULL REFERENCES pulls (id),
  copies INTEGER NOT NULL CHECK (copies >= 1),
  PRIMARY KEY (schedule_id, pull_id)
);

-- ⛔ The database refuses to lose the record, whatever the code above it does. The store opens with
-- recursive_triggers ON, so an INSERT OR REPLACE — which deletes the row it replaces — is refused too.
CREATE TRIGGER employer_fixed_update BEFORE UPDATE ON employer
BEGIN SELECT RAISE(ABORT, 'the record belongs to one employer: employer is never changed'); END;
CREATE TRIGGER employer_fixed_delete BEFORE DELETE ON employer
BEGIN SELECT RAISE(ABORT, 'the record belongs to one employer: employer is never deleted'); END;

CREATE TRIGGER pulls_append_only_delete BEFORE DELETE ON pulls
BEGIN SELECT RAISE(ABORT, 'the record is append-only: pulls rows are never deleted'); END;
CREATE TRIGGER pulls_append_only_update BEFORE UPDATE ON pulls
BEGIN SELECT RAISE(ABORT, 'the record is append-only: pulls rows are never changed'); END;

CREATE TRIGGER day_reads_append_only_delete BEFORE DELETE ON day_reads
BEGIN SELECT RAISE(ABORT, 'the record is append-only: day_reads rows are never deleted'); END;
CREATE TRIGGER day_reads_append_only_update BEFORE UPDATE ON day_reads
BEGIN SELECT RAISE(ABORT, 'the record is append-only: day_reads rows are never changed'); END;

CREATE TRIGGER stamps_append_only_delete BEFORE DELETE ON stamps
BEGIN SELECT RAISE(ABORT, 'the record is append-only: stamps rows are never deleted'); END;
CREATE TRIGGER stamps_append_only_update BEFORE UPDATE ON stamps
BEGIN SELECT RAISE(ABORT, 'the record is append-only: stamps rows are never changed'); END;

CREATE TRIGGER stamp_sightings_append_only_delete BEFORE DELETE ON stamp_sightings
BEGIN SELECT RAISE(ABORT, 'the record is append-only: stamp_sightings rows are never deleted'); END;
CREATE TRIGGER stamp_sightings_append_only_update BEFORE UPDATE ON stamp_sightings
BEGIN SELECT RAISE(ABORT, 'the record is append-only: stamp_sightings rows are never changed'); END;

CREATE TRIGGER schedule_append_only_delete BEFORE DELETE ON schedule
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule rows are never deleted'); END;
CREATE TRIGGER schedule_append_only_update BEFORE UPDATE ON schedule
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule rows are never changed'); END;

CREATE TRIGGER schedule_sightings_append_only_delete BEFORE DELETE ON schedule_sightings
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule_sightings rows are never deleted'); END;
CREATE TRIGGER schedule_sightings_append_only_update BEFORE UPDATE ON schedule_sightings
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule_sightings rows are never changed'); END;
