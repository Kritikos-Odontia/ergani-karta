#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# THE MAC APP — «Κάρτα Εργασίας.app», zipped, for one processor (arm64 or x64):
#   Contents/MacOS/karta       packaging/mac/stub.c, compiled here (both processors in one file)
#   Contents/Resources/        node (Node.js's own binary, signed by the Node.js project), launcher.mjs, app/, licenses/
# Signed AD HOC only (no paid Apple certificate — his ruling): the first open needs System Settings → Privacy &
# Security → «Open Anyway», once (docs/INSTALL-DESKTOP.md). Node.js keeps its own signature: it is not re-signed.
#   build-mac.sh <built desktop folder> <node binary> <node LICENSE> <arm64|x64> <version> <out folder>
set -euo pipefail
desktop=$1 node=$2 node_license=$3 arch=$4 version=$5 out=$6
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
app="$work/Κάρτα Εργασίας.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=13.5 -o "$app/Contents/MacOS/karta" "$here/stub.c"
sed "s/@VERSION@/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
cp "$node" "$app/Contents/Resources/node"
chmod 755 "$app/Contents/Resources/node"
cp -R "$desktop/launcher.mjs" "$desktop/app" "$desktop/licenses" "$app/Contents/Resources/"
cp "$node_license" "$app/Contents/Resources/licenses/LICENSE-node.txt"
if [ -f "$here/icon.icns" ]; then cp "$here/icon.icns" "$app/Contents/Resources/icon.icns"; fi
codesign --force --sign - --identifier ergani-karta "$app"
codesign --verify --strict "$app"
codesign --verify "$app/Contents/Resources/node"
mkdir -p "$out"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/karta-ergasias-$version-mac-$arch.zip"
rm -rf "$work"
