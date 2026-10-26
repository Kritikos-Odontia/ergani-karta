-- SPDX-License-Identifier: EUPL-1.2
-- Settings corrections are new facts. No credential or PIN belongs in this history.
CREATE TABLE settings_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  by TEXT NOT NULL
) STRICT;
CREATE TRIGGER settings_events_no_update BEFORE UPDATE ON settings_events
BEGIN SELECT RAISE(ABORT, 'settings history is append-only'); END;
CREATE TRIGGER settings_events_no_delete BEFORE DELETE ON settings_events
BEGIN SELECT RAISE(ABORT, 'settings history is append-only'); END;
-- Keep every branch, login and old card; retirement only refuses NEW cards, even from an old browser ticket.
CREATE TRIGGER punches_branch_active BEFORE INSERT ON punches
WHEN EXISTS (SELECT 1 FROM settings_events WHERE kind = 'branch-retired' AND subject = NEW.branch)
BEGIN SELECT RAISE(ABORT, 'this branch is retired'); END;
