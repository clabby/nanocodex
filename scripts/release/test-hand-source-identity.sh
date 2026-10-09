#!/usr/bin/env bash
# Black-box check of hand-source-identity.py on a synthetic workspace laid out
# like the release tree: a CLI package with the Hand and shared packages nested
# inside it. Asserts which edits change the identity and that verify fails
# closed on Hand build inputs the identity did not hash.
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hand-source-identity.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
ws="$work/ws"
mkdir -p "$ws"/{.cargo,scripts/tests,macos/HandMenuBar,app/src,app/hand/src,app/hand/tests,app/shared/src}
cd "$ws"
cat > Cargo.toml <<'EOF'
[workspace]
resolver = "2"
members = ["app", "app/hand", "app/shared"]
EOF
cat > app/Cargo.toml <<'EOF'
[package]
name = "cli"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "nanocodex"
path = "src/main.rs"
[dependencies]
shared = { path = "shared" }
EOF
cat > app/hand/Cargo.toml <<'EOF'
[package]
name = "hand-daemon"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "nanocodex-hand"
path = "src/main.rs"
[features]
tempo = []
[dependencies]
shared = { path = "../shared" }
EOF
cat > app/shared/Cargo.toml <<'EOF'
[package]
name = "shared"
version = "0.1.0"
edition = "2021"
EOF
echo 'fn main() {}' > app/src/main.rs
echo '// terminal UI' > app/src/tui.rs
echo 'fn main() {}' > app/hand/src/main.rs
echo '#[test] fn t() {}' > app/hand/tests/journey.rs
echo 'pub fn f() {}' > app/shared/src/lib.rs
for input in .cargo/config.toml nanocodex-vm.entitlements scripts/tests/linux-screen-helpers-bundle.py \
  macos/HandMenuBar/main.swift scripts/aarch64-unknown-linux-musl-linker scripts/aarch64-unknown-linux-musl-ar; do
  echo "# $input" > "$input"
done
echo helpers-v1 > "$work/screen-helpers.tar.gz"
git init -q . && cargo generate-lockfile --offline -q

identity() {
  python3 "$script" compute --target x86_64-unknown-linux-gnu --profile release --features "${features-tempo}" \
    --payload "screen-helpers=$work/screen-helpers.tar.gz" --report "$work/report.json"
}
expect() { # expect same|changed DESCRIPTION
  local next; next="$(identity)"
  [[ "$next" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: no identity after $2" >&2; exit 1; }
  if [[ "$1" == same && "$next" != "$current" ]] || [[ "$1" == changed && "$next" == "$current" ]]; then
    echo "FAIL: expected identity $1 after $2" >&2; exit 1
  fi
  echo "ok: identity $1 after $2"; current="$next"
}
current="$(identity)"
expect same "recomputing an unchanged tree"
echo '// edit' >> app/src/tui.rs;              expect same "a CLI-only source edit"
echo '// edit' >> app/src/main.rs;             expect same "a CLI entry point edit"
echo '// edit' >> app/hand/tests/journey.rs;   expect same "a Hand integration-test edit"
echo '// edit' >> app/hand/src/main.rs;        expect changed "a Hand source edit"
echo '// edit' >> app/shared/src/lib.rs;       expect changed "a shared-package edit"
echo '# edit' >> .cargo/config.toml;           expect changed "a Cargo config edit"
echo helpers-v2 > "$work/screen-helpers.tar.gz"; expect changed "a native payload change"
features=""; expect changed "a feature change"; unset features; current="$(identity)"

verify() { python3 "$script" verify --report "$work/report.json" --dep-info "$work/hand.d"; }
printf '%s: %s %s %s\n' "$ws/target/release/nanocodex-hand" "$ws/app/hand/src/main.rs" "$ws/app/shared/src/lib.rs" \
  "$ws/Cargo.toml $ws/rust-toolchain.toml $ws/target/release/build/out.rs $work/screen-helpers.tar.gz" > "$work/hand.d"
verify >/dev/null && echo "ok: verify accepts hashed sources, absent optional inputs, outputs and payloads"
printf '%s: %s\n' "$ws/target/release/nanocodex-hand" "$ws/app/src/tui.rs" > "$work/hand.d"
if verify 2>/dev/null; then echo "FAIL: verify accepted an unhashed workspace input" >&2; exit 1; fi
echo "ok: verify rejects a Hand input outside the hashed closure"
echo external > "$work/extra.bin"
printf '%s: %s\n' "$ws/target/release/nanocodex-hand" "$work/extra.bin" > "$work/hand.d"
if verify 2>/dev/null; then echo "FAIL: verify accepted an undeclared external input" >&2; exit 1; fi
echo "ok: verify rejects an undeclared external input"
printf '%s: %s\n' "$ws/target/release/nanocodex-hand" "$ws/app/hand" > "$work/hand.d"
if verify 2>/dev/null; then echo "FAIL: verify accepted a directory input with unhashed tests" >&2; exit 1; fi
echo "ok: verify rejects a directory input containing unhashed files"
echo "hand-source-identity: all checks passed"
