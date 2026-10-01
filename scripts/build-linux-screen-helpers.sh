#!/usr/bin/env bash
# Native: requires Python 3, git, curl, xz, cc, pkg-config, readelf, Meson, Ninja,
# libwayland-dev/libwayland-bin, libxkbcommon-dev, libpixman-1-dev, libpng-dev.
# Container mode is for release runners, not an implicit host package installer.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ "${1:-}" == --container ]]; then
  shift
  output=${1:?usage: build-linux-screen-helpers.sh --container OUTPUT.tar.gz}
  mkdir -p "$(dirname "$output")"
  output=$(cd "$(dirname "$output")" && pwd)/$(basename "$output")
  image="nanocodex-screen-helpers:${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
  docker build -f "$root/scripts/build-linux-screen-helpers.Dockerfile" -t "$image" "$root"
  docker run --rm --user "$(id -u):$(id -g)" -v "$(dirname "$output"):/out" "$image" \
    --work-dir /tmp/screen-build --output "/out/$(basename "$output")"
else
  exec python3 "$root/scripts/build-linux-screen-helpers.py" "$@"
fi
