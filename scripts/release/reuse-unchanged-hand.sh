#!/usr/bin/env bash
# Republish the previous release's exact Hand when nothing that reaches it changed.
#
#   scripts/release/reuse-unchanged-hand.sh DIST_DIR PREVIOUS_TAG
#
# For every DIST_DIR/nanocodex2-<target>.identity whose reuse key equals the one
# published on PREVIOUS_TAG, replace the freshly built Hand assets
# (nanocodex2-<target>[.gz], plus nanocodex-app-aarch64-apple-darwin.tar.gz on
# macOS) with that release's checksum-verified bytes. Updaters then see a
# byte-identical Hand and change only the CLI: no Hand restart, and on macOS no
# new code identity. Run before SHA256SUMS is generated. Requires gh with
# GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 DIST_DIR PREVIOUS_TAG" >&2
  exit 2
fi
dist=$1
previous=$2
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}

shopt -s nullglob
identities=("$dist"/nanocodex2-*.identity)
if [[ ${#identities[@]} -eq 0 ]]; then
  echo "This build has no Hand reuse keys; publishing the Hand as built"
  exit 0
fi
if [[ -z "$previous" ]]; then
  echo "No previous release; publishing the Hand as built"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/previous"
gh release download "$previous" --repo "$repository" --dir "$work/previous" \
  --pattern SHA256SUMS --pattern 'nanocodex2-*.identity' || true
if [[ ! -s "$work/previous/SHA256SUMS" ]]; then
  echo "::notice::$previous has no checksum manifest; publishing the Hand as built"
  exit 0
fi

for identity in "${identities[@]}"; do
  name="$(basename "$identity" .identity)"
  target=${name#nanocodex2-}
  if ! cmp -s "$identity" "$work/previous/$name.identity"; then
    echo "$name changed since $previous (or it has no reuse key); publishing the new build"
    continue
  fi
  assets=("$name.gz")
  if [[ "$target" == aarch64-apple-darwin ]]; then
    assets+=(nanocodex-app-aarch64-apple-darwin.tar.gz)
  fi
  rm -rf "$work/assets"
  mkdir "$work/assets"
  patterns=()
  for asset in "${assets[@]}"; do
    patterns+=(--pattern "$asset")
  done
  gh release download "$previous" --repo "$repository" --dir "$work/assets" "${patterns[@]}"
  for asset in "${assets[@]}"; do
    awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print; count++ } END { if (count != 1) exit 1 }' \
      "$work/previous/SHA256SUMS" > "$work/assets/$asset.sha256" || {
      echo "$previous must list exactly one $asset checksum" >&2
      exit 1
    }
    (cd "$work/assets" && sha256sum --check --strict "$asset.sha256")
  done
  for asset in "${assets[@]}"; do
    cp "$work/assets/$asset" "$dist/$asset"
  done
  # Raw compatibility executables are the same bytes, uncompressed.
  if [[ -e "$dist/$name" ]]; then
    gzip -dc "$dist/$name.gz" > "$dist/$name"
    chmod 755 "$dist/$name"
  fi
  echo "::notice title=Unchanged Hand::$name is unchanged since $previous; republishing its exact bytes"
done
