#!/bin/bash
# Build ONLY: never installs, escalates, enrolls, or modifies production state.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --locked --release
target=${CARGO_TARGET_DIR:-target}
mkdir -p "$target/release"
cc -O2 -Wall -Wextra -Werror -fPIE -pie -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -Wl,-z,relro,-z,now c/askpass.c -o "$target/release/nanocodex-secure-askpass"
(cd "$target/release" && sha256sum nanocodex-secure-input nanocodex-secure-askpass)
