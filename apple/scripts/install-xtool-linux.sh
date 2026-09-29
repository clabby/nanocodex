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
[[ $# -le 1 ]] || { echo 'Usage: install-xtool-linux.sh [Xcode.xip|Xcode.app|darwin.xtoolsdk]' >&2; exit 2; }
prefix=${NANOCODEX_XTOOL_PREFIX:-"${XDG_DATA_HOME:-$HOME/.local/share}/nanocodex/xtool-$version"}
mkdir -p "$prefix"
if [[ ! -x "$prefix/squashfs-root/AppRun" ]]; then
  curl --fail --location --retry 3 "https://github.com/xtool-org/xtool/releases/download/$version/xtool-$arch.AppImage" -o "$prefix/xtool.AppImage"
  printf '%s  %s\n' "$digest" "$prefix/xtool.AppImage" | sha256sum --check --status
  chmod +x "$prefix/xtool.AppImage"
  (cd "$prefix" && ./xtool.AppImage --appimage-extract >/dev/null)
fi
[[ $("$prefix/squashfs-root/AppRun" --version) == "xtool $version" ]] || { echo 'Unexpected xtool version' >&2; exit 1; }
printf 'xtool executable: %s/squashfs-root/AppRun\n' "$prefix"
if [[ $# -eq 1 ]]; then
  [[ -e $1 ]] || { echo 'SDK input does not exist' >&2; exit 2; }
  "$prefix/squashfs-root/AppRun" sdk install "$1" --slim
fi
