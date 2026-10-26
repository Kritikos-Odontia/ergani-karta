-- SPDX-License-Identifier: EUPL-1.2
-- Owner reminder overrides, never a schedule filing. A withdrawal is another fact; old entries remain.
CREATE TABLE reminder_calendar (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  -- NULL: personal leave across all branches. A branch: replacement hours for that branch only.
  branch TEXT REFERENCES branches(code),
  kind TEXT NOT NULL CHECK (kind IN ('leave', 'hours', 'reset')),
  intervals TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  by TEXT NOT NULL CHECK (length(trim(by)) > 0),
  at TEXT NOT NULL,
  CHECK (kind <> 'hours' OR branch IS NOT NULL)
);
CREATE INDEX reminder_calendar_by_day ON reminder_calendar(day, employee_id, branch, id);
CREATE TRIGGER reminder_calendar_append_only_update BEFORE UPDATE ON reminder_calendar
BEGIN SELECT RAISE(ABORT, 'the record is append-only: reminder_calendar rows are never changed'); END;
CREATE TRIGGER reminder_calendar_append_only_delete BEFORE DELETE ON reminder_calendar
BEGIN SELECT RAISE(ABORT, 'the record is append-only: reminder_calendar rows are never deleted'); END;
