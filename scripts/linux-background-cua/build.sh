#!/usr/bin/env bash
# Build only: never loads a compositor module or changes desktop configuration.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cmake -S "$root/upstream" -B "$root/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
  -DCUA_HYPRLAND_EXPECTED_VERSION=0.56.2 -DCUA_HYPRLAND_INPUT=ON
cmake --build "$root/build" --parallel 2
