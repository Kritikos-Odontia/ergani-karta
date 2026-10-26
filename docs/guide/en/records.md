# Records and receipts

## Two different records

The **local card record** holds captured cards, attempts, responses and decisions. The **monthly ΕΡΓΑΝΗ archive** holds what the ministry returned for an earlier month. These are different sources; neither proves the other is complete.

Records are appended rather than rewritten. ΕΡΓΑΝΗ keeps a limited period (six months according to the existing technical guidance), while the employer needs a long-term record. The program does not delete that record; confirm your retention duties with the accountant.

## Protocol number and PDF

A confirmed submission returns a protocol number. The proof PDF can be pending separately and is requested again. **A pending PDF does not mean the card failed.** Use `admin queue` to distinguish cards needing a decision from missing receipts. Do not stamp again to obtain a receipt.

## An employee's own record

Employees can request their own records. Give each person only their own file, not the entire staff folder. In a technical installation:

```sh
docker compose exec stamp ergani admin history --afm <tax-identifier> --from YYYY-MM-DD --to YYYY-MM-DD --out /data/stamp/exports
```

This creates a printable Greek page and spreadsheet in a fresh folder for the request. Copy only the printed folder to a protected location outside the code folder and give it only to that employee. For monthly-read exports and schedule comparisons see [ADMIN.md](../../ADMIN.md) (Greek).

## Check the monthly read

The archive runs daily, rereading recent months and appending changes. A failure or unknown response shape does not mean “nobody worked”. With Docker inspect `docker compose logs archive`. Do not leave months unchecked: ΕΡΓΑΝΗ may stop returning them later.
