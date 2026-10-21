-- SPDX-License-Identifier: EUPL-1.2
-- 002 — THE ALARMS: what the service read of ΕΡΓΑΝΗ's declared schedule to know who is due today at each branch, the
-- days the owner marked closed, and every push it sent to the owner's phone. Append-only, like the rest of the record.

-- Once a day per branch, ΕΡΓΑΝΗ's declared schedule (EX_BASE_08) for the same weekday in the latest week it will
-- answer — it answers only for last month and earlier — taken as today's. `rows` is the answer as read (JSON);
-- `error` is why the read failed. Either, never both.
CREATE TABLE schedule_reads (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL REFERENCES branches (code),
  -- The working day the alarms are for, 'YYYY-MM-DD'.
  for_day TEXT NOT NULL CHECK (for_day GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  -- The day ΕΡΓΑΝΗ was asked about, standing in for it.
  source_day TEXT NOT NULL CHECK (source_day GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  at_ms INTEGER NOT NULL,
  rows TEXT,
  error TEXT,
  CHECK ((rows IS NULL) <> (error IS NULL))
);
CREATE INDEX schedule_reads_by_day ON schedule_reads (branch, for_day, at_ms);

-- A day the practice is closed (a public holiday): nobody is «due», so no «has not stamped in» alarm, at any branch.
-- Set by the owner, and withdrawn the same way (quiet = 0) — the latest row for a day decides, and every mark is kept.
CREATE TABLE quiet_days (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  quiet INTEGER NOT NULL CHECK (quiet IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX quiet_days_by_day ON quiet_days (day, id);

-- Every push to the owner's phone: which alarm (`key`), when, and whether the server took it. One alarm is pushed
-- once; a failed push is tried again. The text is not kept here — it names a person, and the key says what it was.
CREATE TABLE pushes (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  at_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  error TEXT
);
CREATE INDEX pushes_by_key ON pushes (key, at_ms);

CREATE TRIGGER schedule_reads_append_only_delete BEFORE DELETE ON schedule_reads
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule_reads rows are never deleted'); END;
CREATE TRIGGER schedule_reads_append_only_update BEFORE UPDATE ON schedule_reads
BEGIN SELECT RAISE(ABORT, 'the record is append-only: schedule_reads rows are never changed'); END;

CREATE TRIGGER quiet_days_append_only_delete BEFORE DELETE ON quiet_days
BEGIN SELECT RAISE(ABORT, 'the record is append-only: quiet_days rows are never deleted'); END;
CREATE TRIGGER quiet_days_append_only_update BEFORE UPDATE ON quiet_days
BEGIN SELECT RAISE(ABORT, 'the record is append-only: quiet_days rows are never changed'); END;

CREATE TRIGGER pushes_append_only_delete BEFORE DELETE ON pushes
BEGIN SELECT RAISE(ABORT, 'the record is append-only: pushes rows are never deleted'); END;
CREATE TRIGGER pushes_append_only_update BEFORE UPDATE ON pushes
BEGIN SELECT RAISE(ABORT, 'the record is append-only: pushes rows are never changed'); END;
