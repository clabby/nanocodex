#!/bin/bash
# Build/archive only; no installation, enrollment, sudo, PAM, or system changes.
set -euo pipefail
cd "$(dirname "$0")"
bash build-release.sh
target=${CARGO_TARGET_DIR:-target}
package="$target/package/nanocodex-secure-input-linux"
mkdir -p "$package/resources"
cp -- "$target/release/nanocodex-secure-input" "$target/release/nanocodex-secure-askpass" "$package/"
cp -- install-local.sh README.md "$package/"
cp -- resources/nanocodex-secure-input.service "$package/resources/"
chmod 0755 "$package/nanocodex-secure-input" "$package/nanocodex-secure-askpass" "$package/install-local.sh"
# The askpass becomes setuid ONLY through separately trusted local installation.
(cd "$package" && sha256sum nanocodex-secure-input nanocodex-secure-askpass > SHA256SUMS)
tar -czf "$target/package/nanocodex-secure-input-linux.tar.gz" -C "$target/package" nanocodex-secure-input-linux
sha256sum "$target/package/nanocodex-secure-input-linux.tar.gz"
