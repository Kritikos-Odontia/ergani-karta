# After an outage — sending queue

If ΕΡΓΑΝΗ is unavailable but the staff page can capture cards, staff continue **on that page**. Each card is saved before sending. Do not repeat the same movement in CardScanner.

## Fresh cards and older unresolved cards

After each attempt the program rechecks the queue. Fresh cards get priority within their own sending window over unrelated older late cards. An earlier card for the same person and working day that is ready to send can go first, including across branches. Otherwise at most one old late card is tried per pass.

A request already in flight finishes before another begins. Slow responses, sign-in and ministry waits can still delay a fresh card. Priority does not guarantee receipt within 15 minutes.

## Ordering safeguards remain

- A departure does not wait for the next retry of a failed arrival.
- An older arrival is not sent if a later card for the same person and working day may already have reached ΕΡΓΑΝΗ. The accountant handles that case.
- Across midnight and restarts the queue uses saved cards and their original working day. Restarting does not create a new declaration.

Automatic attempts stop at minute 14. Use **Τι κάνω; (What do I do?)** when a decision is needed and follow [reasons and accountant handling](failures.md). A backlog does not automatically make a late declaration compliant.

If the page cannot capture a card at all, use [CardScanner](daily.md). **Restoring a backup** first needs the separate [check before sending resumes](new-computer.md). Technical rules: [DECISIONS.md](../../DECISIONS.md).
