#!/bin/sh
# SPDX-License-Identifier: EUPL-1.2
# Remove the program installed by install.sh. ⛔ The data (~/.local/share/karta-ergasias) stays: it is the employer's
# five-year record.
set -eu
systemctl --user disable --now karta-ergasias.service >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/karta-ergasias.service" "$HOME/.local/share/applications/karta-ergasias.desktop"
rm -rf "$HOME/.local/opt/karta-ergasias"
echo "Το πρόγραμμα αφαιρέθηκε. Το αρχείο σας μένει στο ${XDG_DATA_HOME:-$HOME/.local/share}/karta-ergasias — κρατήστε το πέντε χρόνια."
