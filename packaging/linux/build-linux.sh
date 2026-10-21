#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# LINUX — a .deb (double-click opens the system's software installer) and a .tar.gz with an install script, for
# other distributions. Both start the program at sign-in as a systemd USER service, for every user, and add the icon.
# The data stays in each user's ~/.local/share/karta-ergasias; removing the program never deletes it.
#   build-linux.sh <built desktop folder> <node binary> <node LICENSE> <version> <out folder>
set -euo pipefail
desktop=$1 node=$2 node_license=$3 version=$4 out=$5
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
mkdir -p "$out"

stage() { # <folder>: node, launcher.mjs, app/, licenses/
  mkdir -p "$1"
  cp "$node" "$1/node"
  chmod 755 "$1/node"
  cp -R "$desktop/launcher.mjs" "$desktop/app" "$desktop/licenses" "$1/"
  cp "$node_license" "$1/licenses/LICENSE-node.txt"
  if [ -f "$here/icon.png" ]; then cp "$here/icon.png" "$1/icon.png"; fi
}

# ── .deb ──────────────────────────────────────────────────────────────────────────────────────
deb="$work/deb"
stage "$deb/opt/karta-ergasias"
install -D -m 644 "$here/karta-ergasias.service" "$deb/usr/lib/systemd/user/karta-ergasias.service"
sed "s|@PREFIX@|/opt/karta-ergasias|g" "$here/karta-ergasias.desktop" | install -D -m 644 /dev/stdin "$deb/usr/share/applications/karta-ergasias.desktop"
mkdir -p "$deb/DEBIAN"
sed "s/@VERSION@/$version/" "$here/control" > "$deb/DEBIAN/control"
install -m 755 "$here/postinst" "$deb/DEBIAN/postinst"
install -m 755 "$here/prerm" "$deb/DEBIAN/prerm"
dpkg-deb --root-owner-group --build "$deb" "$out/karta-ergasias-$version-linux-x64.deb"

# ── .tar.gz ───────────────────────────────────────────────────────────────────────────────────
name="karta-ergasias-$version-linux-x64"
stage "$work/$name/program"
cp "$here/karta-ergasias.service" "$here/karta-ergasias.desktop" "$work/$name/program/"
install -m 755 "$here/install.sh" "$work/$name/install.sh"
install -m 755 "$here/uninstall.sh" "$work/$name/uninstall.sh"
tar -C "$work" -czf "$out/$name.tar.gz" "$name"
rm -rf "$work"
