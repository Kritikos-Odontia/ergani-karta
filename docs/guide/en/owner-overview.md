# Owner daily overview

On the installation computer open **Αρχική (Home)** and sign in with the owner password. It covers all branches. Refresh for current information; times use Greece's timezone.

| Indicator | What to check |
|---|---|
| **Card submissions** | Today's cards needing a decision, separately from earlier cards. Waiting for confirmation differs from failure. Open **Εκκρεμότητες (Pending)** to decide. |
| **PDF receipts** | Confirmed submissions whose PDF is still missing. The list shows name, branch and time. Do not stamp again. |
| **ΕΡΓΑΝΗ connection** | At least ten minutes without an address response. Open the separate [connection check](connection-check.md) for each user. This indicator does not verify permissions. |
| **Backup** | The last attempt and its outcome. A failed attempt or a success older than one day needs attention on **Αντίγραφα (Backups)**. |
| **Monthly ΕΡΓΑΝΗ archive** | Last successful daily check, newer failure, incomplete months/branches, zero-movement warnings and comparison pages that were not written. A success older than 36 hours is flagged. |

“Today” means the actual stamp date in Greece. A departure after midnight appears today even when its working day is yesterday. Earlier unresolved cards remain visible.

## What the archive indicator proves

Home reads saved local information. Archive success time describes the **daily check**, which can reuse complete reads up to seven days old. It does not mean every movement was fetched again then. Before a daily status exists, a separately labelled complete read concerns just one month/branch.

A newer failure does not hide the last success. Months that fell outside ΕΡΓΑΝΗ's available window remain listed, although they can no longer be retrieved there. A failed comparison-page write can coexist with complete stored records. If the local store is unreadable, follow [recovery instructions](new-computer.md).

## What to do next

Opening Home does not file a card, choose a reason or make a backup. Follow the relevant indicator's link. PDF retrieval retries automatically; the list says when retrieval stopped because the filing is too old (183-day limit). Tell the accountant then.

Notify the Labour Inspectorate immediately when a condition prevents transmission, and again as soon as it ends, even if later retries deliver every card within fifteen minutes. Selecting a late-filing reason does not replace these two notifications.

Do not repeat a recorded card because its response or PDF is pending. Use [CardScanner](daily.md) when the page cannot capture a card. For a card that missed its window see [failures and the accountant](failures.md). Detailed reference: [OWNER-OVERVIEW.md](../../OWNER-OVERVIEW.md).
