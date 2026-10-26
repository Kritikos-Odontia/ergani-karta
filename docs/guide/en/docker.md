# Technical installation — Docker

For the person maintaining the computer: Docker with Compose 2.24+, Git, and a private address reachable by staff devices. Linux is recommended; allow about 400 MB memory. Connect other buildings through a private network such as Tailscale. No port forwarding or public tunnel.

## Install the version this guide describes

Use the [version's source code](download.md) in a folder such as `/opt/ergani`, then build it. The owner enters restricted credentials directly in setup; they are not given to an assistant or chat.

```sh
docker compose build
docker compose run --rm setup
docker compose run --rm stamp ergani admin init
docker compose run --rm archive ergani pull --init-store
docker compose up -d
docker compose ps
```

Setup writes `.env` with owner-only permissions. It contains passwords: do not print it, commit it or send it in a message. Do not give the program the employer's master ΕΡΓΑΝΗ credentials. The head office is branch `0`.

The two volumes, `ergani-<name>_stamp` and `ergani-<name>_records`, are the record. Do not delete them. Trial and production registers need separate installations and stores.

## Before staff begin

Follow [access setup](access.md): a user per branch, explicit restriction checks in the portal, staff, enrolled devices and personal PINs. `docker compose exec stamp ergani check` only reads; it is neither a test filing nor proof of every permission.

Print [daily use](daily.md). The first card is a real arrival. Detailed commands and adding a branch are in [INSTALL.md](../../INSTALL.md) and [ADMIN.md](../../ADMIN.md) (Greek). A new branch must also be registered in the record before restarting the service.

If the page is missing after a Tailscale restart, wait for the private network to connect, then run `docker compose up -d` again.

The daily monthly-archive read runs at 03:15. Monitor `docker compose logs archive`. Arrange [backups](backups.md) off the computer.

To stop: `docker compose down`, **without `-v`**. Keep the volumes.
