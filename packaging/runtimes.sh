#!/bin/bash
# SPDX-License-Identifier: EUPL-1.2
# THE RUNTIMES — Node.js's own binary for each system, from nodejs.org, each archive checked against the sha256
# pinned in packaging/node.json (taken from Node's signed SHASUMS256.txt) before anything is unpacked. Out:
#   <out>/<system>/node (node.exe)  and  <out>/<system>/LICENSE      system: win32-x64 darwin-arm64 darwin-x64 linux-x64
#   runtimes.sh <out folder>
set -euo pipefail
out=$1
here=$(cd "$(dirname "$0")" && pwd)
version=$(node -p "require('$here/node.json').version")
work=$(mktemp -d)
for pair in win32-x64:win-x64.zip darwin-arm64:darwin-arm64.tar.gz darwin-x64:darwin-x64.tar.gz linux-x64:linux-x64.tar.gz; do
  system=${pair%%:*}
  file="node-v$version-${pair#*:}"
  want=$(node -p "require('$here/node.json').sha256['$file']")
  curl -fsSL --retry 3 -o "$work/$file" "https://nodejs.org/dist/v$version/$file"
  got=$( (sha256sum "$work/$file" 2>/dev/null || shasum -a 256 "$work/$file") | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then echo "$file: sha256 $got, pinned $want — refused" >&2; exit 1; fi
  mkdir -p "$out/$system"
  folder="${file%.zip}"; folder="${folder%.tar.gz}"
  if [ "$system" = win32-x64 ]; then
    unzip -q -j "$work/$file" "$folder/node.exe" "$folder/LICENSE" -d "$out/$system"
  else
    tar -xzf "$work/$file" -C "$work" "$folder/bin/node" "$folder/LICENSE"
    mv "$work/$folder/bin/node" "$work/$folder/LICENSE" "$out/$system/"
  fi
done
rm -rf "$work"
echo "Node.js $version for four systems in $out"
