#!/bin/sh
# SPDX-License-Identifier: EUPL-1.2
# Κάρτα Εργασίας for this user, without administrator rights: the program into ~/.local/opt/karta-ergasias, a systemd
# user service that starts it at sign-in, and the icon in the applications menu. Then it opens the owner's page.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
prefix="$HOME/.local/opt/karta-ergasias"
systemctl --user stop karta-ergasias.service >/dev/null 2>&1 || true
rm -rf "$prefix"
mkdir -p "$prefix" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
cp -R "$here/program/." "$prefix/"
sed "s|/opt/karta-ergasias|$prefix|g" "$here/program/karta-ergasias.service" > "$HOME/.config/systemd/user/karta-ergasias.service"
sed "s|@PREFIX@|$prefix|g" "$here/program/karta-ergasias.desktop" > "$HOME/.local/share/applications/karta-ergasias.desktop"
systemctl --user daemon-reload >/dev/null 2>&1 || true
systemctl --user enable --now karta-ergasias.service >/dev/null 2>&1 || true
"$prefix/node" "$prefix/launcher.mjs" open
