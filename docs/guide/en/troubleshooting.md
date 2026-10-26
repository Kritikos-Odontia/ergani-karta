# Troubleshooting

## The page does not open

Staff first use [CardScanner](daily.md) if the page cannot capture a card. Check that the computer is on, its user is signed in and the program is running. On that computer try `http://127.0.0.1:8881` for the owner page.

If it works there but not on a phone: check the same protected Wi-Fi, correct private address, port 8880 and device enrolment. Windows must classify the network as Private; on Mac check node's firewall permission. Do not solve this by allowing public access.

## Device not enrolled

Issue a fresh link for that device. It is single-use, lasts 30 minutes and belongs to a particular branch. Another browser or cleared cookies can need enrolment again. Revoke old devices you no longer use.

## Wrong PIN or lockout

Five wrong attempts cause a ten-minute lockout. The owner can unlock access or issue a temporary PIN. The employee chooses their own again without sharing it. Do not try another person's PIN.

## ΕΡΓΑΝΗ connection fails

Check internet access and the selected register. With the owner verify the restricted user and portal settings. Do not substitute master credentials. Reading an earlier month can fail separately from sign-in. See [failed submissions](failures.md).

## Missing receipt, monthly archive or backup

Protocol number without PDF: check the pending receipt; do not stamp again. Failed monthly read: inspect archive messages; do not interpret failure as an empty month. Failed backup: check the USB connection, destination folder and free space. See [records](records.md) and [backups](backups.md).

## Recovery problem

Use a complete backup with `recovery.json` and the owner password from that date. The program does not overwrite an existing record. After recovery, stopped sending is expected until the [check with the accountant](new-computer.md). Do not bypass that hold by copying only the SQLite files.

## Reporting a bug

Support is not provided. You can report a bug to the project with version, operating system and reproduction steps using fabricated data. No real tax identifiers, names, protocol numbers, logins or settings files. For a security flaw use [private reporting](download.md), not a public issue.
