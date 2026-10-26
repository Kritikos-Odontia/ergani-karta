# Failed submissions and the accountant

The program saves the card before trying to send it. Automatic attempts stop at minute 14, leaving a margin before the statutory 15 minutes. A local record **is not** confirmation that ΕΡΓΑΝΗ received it.

## When “Τι κάνω;” appears

Review the card and message. A late send needs a person to choose a reason; it is not automatically retried beyond the limit:

| Ministry reason | Meaning |
|---|---|
| 001 | Power / telecommunications |
| 002 | Employer systems |
| 003 | Connection to ΕΡΓΑΝΗ |

If the card was handled another way, choose “covered” for the actual reason. This does not mean the program filed it. With Docker: `admin queue`, `admin decide --card N --reason 001` or `--covered` ([ADMIN.md](../../ADMIN.md), Greek).

**The reason does not replace labour-inspectorate notifications.** The employer notifies the inspectorate when the problem begins and again when it ends. Contact your accountant promptly about the correct handling.

## When the accountant is needed

An older arrival can be stopped if a later card for the same person and working day may already have been filed. A departure is not held back waiting for an arrival. The page asks you to inform the accountant, who handles the correction. The employer does not insert a new card for the employee.

Keep unresolved cards, the actual incident and receipts for the accountant through a secure channel. Do not put them in a public issue or chat. Check [protocol numbers and PDF receipts](records.md) separately.
