#!/usr/bin/env bash
# Build reviewed multi-profile zsign from a checksum-pinned public source archive.
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'zsign installer requires Linux' >&2; exit 2; }
[[ $# == 0 ]] || { echo 'Usage: install-zsign-linux.sh (optional ZSIGN_PREFIX)' >&2; exit 2; }
revision=614caa8d1ca949e260e5746144aa52d27a4b08d6
digest=a373dc5ddbf81ba5c435a48c14b4a2857506c3dde02ec62e0136b6968797384b
prefix=${ZSIGN_PREFIX:-"${XDG_DATA_HOME:-$HOME/.local/share}/nanocodex/zsign-$revision"}
for tool in curl tar sha256sum make g++ pkg-config; do
  command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
pkg-config --exists openssl || { echo 'OpenSSL development headers required (libssl-dev on Debian/Ubuntu).' >&2; exit 1; }
mkdir -p "$prefix"
staging=$(mktemp -d "$prefix/.build-XXXXXXXX")
trap 'rm -rf "$staging"' EXIT
curl --fail --location --retry 3 "https://codeload.github.com/zhlynn/zsign/tar.gz/$revision" -o "$staging/source.tar.gz"
printf '%s  %s\n' "$digest" "$staging/source.tar.gz" | sha256sum --check --status
mkdir "$staging/source"
tar -xzf "$staging/source.tar.gz" --strip-components=1 -C "$staging/source"
make -C "$staging/source/build/linux" -j2 "VERSION=nanocodex-$revision"
install -m 0755 "$staging/source/bin/zsign" "$prefix/zsign"
printf 'Set ZSIGN_PATH=%s/zsign\n' "$(cd "$prefix" && pwd)"
