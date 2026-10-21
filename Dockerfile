# SPDX-License-Identifier: EUPL-1.2
# The one image every service runs (docker-compose.yml, docs/INSTALL.md):
#   · `ergani stamp`   — the reception pages and the outbox: FILES card declarations to ΕΡΓΑΝΗ;
#   · `ergani archive` — the monthly archive: READ ONLY, files nothing;
#   · `ergani setup` / `admin` / `check` / `pull` / `export` — the owner's tools.
# The record stores need Node's built-in SQLite without a flag (src/records/store.ts), which Node 24 has.
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only. The program runs from source under `tsx`, so tsx is a runtime dependency beside zod.
# ⛔ No test or build tooling in the image: every package in an image that files and keeps the record is one more
# thing whose advisories reach it.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

# `ergani` on the PATH, for `docker compose run` and `docker compose exec` alike — ONE node process with tsx loaded
# into it (not tsx's own command, which runs the program as a child and cuts its stop short: the card on its way gets
# the whole `stop_grace_period`). And the two stores' folders: they
# live in named volumes mounted here, and an EMPTY named volume takes its directory's owner and mode on first mount, so
# the unprivileged `node` user can write them and no other user can read them — they hold ΑΦΜ and working time.
RUN printf '#!/bin/sh\nexec node --import file:///app/node_modules/tsx/dist/loader.mjs /app/src/cli.ts "$@"\n' > /usr/local/bin/ergani \
 && chmod 755 /usr/local/bin/ergani \
 && mkdir -p /data/stamp /data/records /install \
 && chown node:node /data/stamp /data/records \
 && chmod 700 /data/stamp /data/records

USER node
CMD ["ergani", "help"]
