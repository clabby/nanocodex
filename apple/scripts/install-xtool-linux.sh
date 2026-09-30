#!/usr/bin/env bash
# Install a pinned Linux xtool binary without FUSE or macOS.
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'xtool installer requires Linux' >&2; exit 2; }
version=1.20.1
case $(uname -m) in
  x86_64) arch=x86_64; digest=040c58d5c708f613b9b74cbdb24e25e8d72c47ff86941f19463626d811159831;;
  aarch64) arch=aarch64; digest=160faf9dbb3882230800262c1852a9c3269cfbf86405907239123afc9022c9d0;;
  *) echo 'Unsupported architecture' >&2; exit 2;;
esac
[[ $# -le 1 ]] || { echo 'Usage: install-xtool-linux.sh [Xcode.xip|Xcode.app|darwin.xtoolsdk|SDK.tar.gz]' >&2; exit 2; }
prefix=${NANOCODEX_XTOOL_PREFIX:-"${XDG_DATA_HOME:-$HOME/.local/share}/nanocodex/xtool-$version"}
mkdir -p "$prefix"
# Coordinate installs sharing a prefix; stage downloads and extraction outside the live tree.
exec 9>"$prefix/.install.lock"
flock 9
if [[ ! -x "$prefix/squashfs-root/AppRun" ]]; then
  stage=$(mktemp -d "$prefix/.install-XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  curl --fail --location --silent --show-error --retry 3 --proto '=https' --proto-redir '=https' \
    "https://github.com/xtool-org/xtool/releases/download/$version/xtool-$arch.AppImage" -o "$stage/xtool.AppImage"
  printf '%s  %s\n' "$digest" "$stage/xtool.AppImage" | sha256sum --check --status
  chmod +x "$stage/xtool.AppImage"
  (cd "$stage" && ./xtool.AppImage --appimage-extract >/dev/null)
  [[ $("$stage/squashfs-root/AppRun" --version) == "xtool $version" ]] || { echo 'Unexpected xtool version' >&2; exit 1; }
  # A failed prior extraction must never satisfy the installed executable check.
  if [[ -e "$prefix/squashfs-root" ]]; then
    mv "$prefix/squashfs-root" "$stage/incomplete-root"
  fi
  mv "$stage/squashfs-root" "$prefix/squashfs-root"
  rm -rf "$stage"
  trap - EXIT
fi
[[ $("$prefix/squashfs-root/AppRun" --version) == "xtool $version" ]] || { echo 'Unexpected xtool version' >&2; exit 1; }
printf 'xtool executable: %s/squashfs-root/AppRun\n' "$prefix"
flock -u 9
if [[ $# -eq 1 ]]; then
  [[ -e $1 ]] || { echo 'SDK input does not exist' >&2; exit 2; }
  case "$1" in
    *.tar.gz|*.tgz|*.tar.xz)
      [[ -n ${NANOCODEX_IOS_SDK_SHA256:-} ]] || { echo 'Set NANOCODEX_IOS_SDK_SHA256 for a private SDK archive' >&2; exit 2; }
      exec python3 "$(dirname "$0")/xtool-sdk-linux.py" import "$1" \
        --sha256 "$NANOCODEX_IOS_SDK_SHA256" --xtool "$prefix/squashfs-root/AppRun"
      ;;
    *) exec python3 "$(dirname "$0")/xtool-sdk-linux.py" install "$1" --xtool "$prefix/squashfs-root/AppRun";;
  esac
fi
