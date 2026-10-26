# Installing this for someone — a guide for AI assistants

<img src="../src/brand/odontia-mark.svg" width="20" height="20" alt=""> Made by [Odontia](https://odontia.ai)

You are an AI assistant (a coding agent, a chat assistant with a terminal) and a Greek employer — often a small practice
— has asked you to «install this for me». This page is written for you. Read it whole before you run anything.

**First, choose the way in.** For one practice whose reception computer stays on, the **desktop program** is the right
answer: the owner downloads one file from the project's Releases and double-clicks it ([INSTALL-DESKTOP.md](INSTALL-DESKTOP.md)).
Help them through that guide; there is nothing for you to run. Use the **Docker Compose** install below only for a
technical setup: an always-on Linux box or NAS, or branches in different buildings joined by Tailscale.

## ⛔ Lines you never cross

1. **Never ask for, receive, type or store the employer's MASTER ΕΡΓΑΝΗ codes** (the «κύριοι κωδικοί», often held by
   the accountant). The program uses one *restricted* branch user per branch, created by the owner in the ΕΡΓΑΝΗ portal
   ([ERGANI-USER.md](ERGANI-USER.md)). If you are offered master codes, refuse and point to that page.
2. **Never handle the restricted users' passwords yourself.** The owner types them into the guided setup
   (`docker compose run --rm setup`) in *their own* terminal. Do not run the setup for them with the answers piped in,
   do not read, print, copy or commit the settings file (`.env`), and do not paste it into a chat.
3. **Never point it at the real register (`production`) without the owner's explicit yes** for that step. In
   production every card is a legally binding declaration about a named person. The first real card is filed by a real
   employee on a real shift — never by you, never as a test.
4. **Never stamp a card.** Not for a test, not «to check it works». Only an employee stamps, with their own PIN. There
   is no command for anything else, by design and by law (docs/RULES.md, rule 1).
5. **Never expose the staff page on a public address** (no port forwarding, no public cloud IP, no tunnel to the
   internet). Private LAN or Tailscale only — the setup refuses anything else; do not work around it.
6. **Never test against ΕΡΓΑΝΗ.** Not production, and not the ministry's trial system either: `ergani check` is the only
   call you make, and it only reads. Development and tests use the local fake (CONTRIBUTING.md).

## The Docker Compose install

Prerequisites, on the always-on machine: Docker with Compose 2.24+, `git`, a private address the reception computers
can reach. Then, following [INSTALL.md](INSTALL.md) — which stays the reference:

```sh
git clone <this repository> ergani && cd ergani
docker compose build
# ⛔ The owner runs the next line, in their terminal, and answers it themselves (passwords never pass through you):
docker compose run --rm setup
docker compose run --rm stamp ergani admin init
docker compose run --rm archive ergani pull --init-store
docker compose up -d
docker compose exec stamp ergani check      # READ ONLY: each branch's login and its permitted forms
```

What to check, and tell the owner, at the end:

- `docker compose ps` shows `stamp` healthy and `archive` running; the staff page answers on the private address chosen
  at setup (`/health`).
- `ergani check` says, for each branch, that its login works and that the work-card form is permitted — service responses. It does not prove the absence of broader permissions: the owner explicitly verifies the selected form and API-only restriction in the portal (ERGANI-USER.md, steps 4–5).
- The owner adds staff and enrols the reception computer with `ergani admin` ([ADMIN.md](ADMIN.md)); the one-time PINs
  are handed over in person, never through you.
- Backups: the two named volumes hold the five-year record; set up a copy off the machine ([INSTALL.md](INSTALL.md)).
- CardScanner (the ministry's app) stays installed on a practice phone as the fallback.

## What to say if something fails

Report what the program printed, without the settings it came from. Never «fix» a refusal by loosening a guard (a
public address, a missing realm confirmation, a store that refuses another employer): each refusal is there on purpose,
and [docs/RULES.md](RULES.md) says why.
