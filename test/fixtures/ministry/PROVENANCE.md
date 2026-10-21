# Provenance — the ministry's own files

⛔⛔ **These files are EVIDENCE. Do not edit them to make a test pass.** They are the Ministry of
Labour's own published artefacts. If one disagrees with our code, **our code is wrong**.
`test/fake.test.ts` checks every file in this folder against the SHA-256 below, so an edit turns the
suite red. `.gitattributes` keeps git from changing their line endings (they are CRLF, and the XSD
starts with a UTF-8 BOM, exactly as published).

## What they are

| file | what it is | bytes | sha256 |
|---|---|---|---|
| `Card_v1.xsd` | The schema of the work-card submission `WRKCardSE`: fields, patterns, lengths, the `f_type` enumeration. | 5508 | `ee5d60902fa716d41981aec4514bd37a15c394fba412c4a6831279f9a532ce5d` |
| `Card.json` | The ministry's example request body: one Card, one event. | 434 | `3da7bd9438bf6c65a5ae4d0ac97fce690f99b1602244394d2c0e0e4343855184` |
| `WorkCard_2submissions.json` | The ministry's example request body: two Cards in one POST. | 1197 | `f6ddf0275902863e9ad7e73ec0d6bd3a113f40c19ab7dbe724826c2fc1c09538` |

⚖ They are the ministry's publication, reproduced unchanged as test evidence. This project's licence (EUPL-1.2)
covers the project's own files, not these three.

## Where they come from

- **Publisher:** Υπουργείο Εργασίας & Κοινωνικής Ασφάλισης. They are the attachments («Συνοδευτικά αρχεία»,
  §3) of the ΕΡΓΑΝΗ ΙΙ guide «Σύστημα Εκτέλεσης Υπηρεσιών Διαλειτουργικότητας», 18.02.2026.
- **Source:** the `e-forosimv.gr` announcement «Πληροφοριακό Σύστημα Εργάνη ΙΙ - Οδηγός Εφαρμογής Σύστημα
  Εκτέλεσης Υπηρεσιών Διαλειτουργικότητας» (`details.asp?ID=78780`, 18.02.2026), which mirrors the
  ministry's attachments. Downloaded without a login.
- **Retrieved:** 2026-09-21, as `ergani-help-files-18.02.2026.zip` (sha256
  `46efb2f6b808d4817b1ef1454cf02a3e383a53b955cf2b33049e705ecd132908`, 161 files). Paths in the zip:
  `xsds/Card_v1.xsd`, `json examples/Card.json`, `json examples/WorkCard_2submissions.json`.
- **Copied here:** 2026-09-25, byte-identical to the zip entries (same sha256), so that the tests read the
  ministry's own bytes in CI too.

## What to know before reading them

- ⚠⚠ **`WorkCard_2submissions.json` is two BRANCHES of ONE employer, not a split shift.** The file name
  suggests one, and has already misled one reader. `f_afm_ergodoti` is the same in both Cards
  (`"000000001"`), and `f_aa` is `"0"` and then `"1"`. The second Card's two events are two different
  people (`000000002` starts, `000000003` finishes), so it is not even one person's day. It shows that
  one POST can cover several branches of the same employer. It says nothing about σπαστό ωράριο
  (measurement M1).
- ⚠ **`Card.json` is not strict JSON.** Its one event ends in a trailing comma (`"f_aitiologia": "",}`).
  It is kept exactly as published. The test says so, allows only that comma, and then checks the file
  against the schema.
- The ΑΦΜ values inside (`111111111`, `999999999`, `000000000`–`000000003`) are the ministry's own
  example values. None is a real person.
- `f_date` has an offset and seven fractional digits in `WorkCard_2submissions.json`, and no offset in
  `Card.json`. `xs:dateTime` allows both.

## ⚠⚠ What the fake (`test/fake/ergani-fake.ts`) makes up — UNMEASURED

These files and the guide define the card and the routes. They say nothing about the two read services
the app uses, `EX_BASE_07` and `EX_BASE_08`. A read-only production call of 24/09/2026 recorded their
field names, the permissions and the date window. It saw **zero rows** and did not record:

1. **The NAME of the Date parameter.** The fake uses the placeholders `UnmeasuredDate07` /
   `UnmeasuredDate08` (`UNMEASURED_DATE_PARAMETER`).
2. **The KEY that holds the rows** under the service code. The fake uses the placeholders
   `UnmeasuredRows07` / `UnmeasuredRows08` (`UNMEASURED_ROWS_KEY`). Also unknown: what an empty answer
   looks like, and whether a single row comes as a one-element array (the fake's choice) or as a bare
   object. The guide's only two examples, EX_BASE_01 and EX_BASE_04, each show a bare object.

Less visible, and just as unmeasured:

3. **The format of each value in a row:** `DD/MM/YYYY`, `HH:mm`, `"0"`/`"1"` flags, `""` for a day with no
   hours.
4. **`Afm` on an `EX_BASE_08` row.** It is not in the recorded field list. It is inferred from «per
   employee per day». The `Type` codes `ΕΡΓ` / `ΑΔΠΠΜ` come from the guide's §4, not from a real row.

⛔ **None of these is the ministry's.** Code must learn (1) from `ServicesList` at run time, and must
treat an answer it cannot recognise as an error, never as a month with no stamps. The first real pull
confirms all four.

## What the fake takes from a real measurement (24/09/2026)

`WRKCardSE` is id **184** (not the guide's 82). The employer may use `EX_BASE_01, 02, 03, 05, 06, 07, 08`
(**not 04**). There is one branch, `"0"`. Dates are `DD/MM/YYYY`, and `PararthmaAa` is declared `Int`.
⛔⛔ The read window, tested on both sides: `24/09/2026` and `01/09/2026` → HTTP 400 «Criteria doesn't
meet requirements»; `31/08/2026` and `15/07/2026` → 200.

⛔ **A green suite against the fake proves we speak the DOCUMENTED protocol. It does not prove the live
system behaves as documented, and it does not replace a real, read-only call (`ergani check`).**
