# Connection and permission checks

From **Αρχική (Home)** open **Έλεγχος σύνδεσης (Connection check)**. With Docker use `docker compose exec stamp ergani check`. It only reads; it does not stamp or submit a test card.

## What it confirms

For each branch it checks sign-in, whether the catalogue offers the `WRKCardSE` form and, where standing-schedule reading is enabled, whether `EX_BASE_08` answers for one previous-month day.

It does not read `EX_BASE_07` or verify monthly-archive completeness. A failed read is shown as a failure, not “no movements”.

## Your required separate step

A successful check **does not prove** filing permission, card-only scope, API-only access or the correct branch.

1. Using master credentials **only in the ΕΡΓΑΝΗ portal**, reload each restricted user.
2. Verify the branch, **only** the arrival/departure form, API-only access and activation with those restrictions. See [user setup](access.md).
3. On the program's connection page select the confirmation checkbox and **Καταγραφή δικής μου επιβεβαίωσης (Record my confirmation)**. The date records your check, not an automatic ministry certification.

Changing local settings asks for confirmation again. Portal-only changes cannot be detected automatically: check and record again. With Docker complete the same portal steps and keep your own note; the command reminds you.

The Home connection indicator is separate: it detects a lack of address responses, not valid credentials or restricted permissions. Reference: [ERGANI-USER.md](../../ERGANI-USER.md).
