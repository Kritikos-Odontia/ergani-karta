# Program updates

## Desktop program

**Ενημερώσεις** shows your version, the night-update switch and **Ενημέρωση τώρα (Update now)**. The program checks GitHub daily for a new version. ΕΡΓΑΝΗ submissions and optional notifications are separate program connections.

Night installation runs between 02:00 and 05:00, provided nobody stamped in the last hour and no card is in flight. If the computer is off every night, update manually outside working hours. The staff page stops briefly.

The program verifies the file-list signature against the project's key and checks downloaded file hashes before accepting an update. This differs from Apple/Microsoft certificates for the initial installer. [Technical signing details](../../SIGNING.md).

## If a new version fails to start

During initial probation, before card dispatch starts, the previous version and its snapshot are restored. After successful probation, repeated startup failures can roll back only the program. If the store format changed and the older version cannot read it, the service refuses to start. This is not recovery from every failure; keep a [backup](backups.md).

## Windows specifics

The installer's Node.js runtime is updated by a newer installer. A new major Node.js line needs the installer linked on the updates page. A rare fallback across major lines can require new firewall permission for phones on the private network. See [known limits](../../KNOWN-LIMITS.md).

## Docker

Outside working hours, make a backup, obtain the selected release's source, run `docker compose build` and `docker compose up -d`. Follow its release notes. Do not manually downgrade record stores: format changes go forward only. The detailed installation reference is [INSTALL.md](../../INSTALL.md) (Greek).
