#!/bin/bash
# LOCAL TRUSTED ADMIN ONLY. Never invoke from a Hand/agent/session or CI installer.
# Administrator verifies the release hashes and backend key via independent channels.
set -euo pipefail
[[ $EUID == 0 && -t 0 && -t 1 && $# == 6 ]] || { echo 'Local root console required: install-local.sh RELEASE_DIR HELPER_SHA256 ASKPASS_SHA256 BACKEND_PUBLIC_KEY TRANSPORT_UID SUDO_UID' >&2; exit 64; }
release=$1; helper_hash=$2; askpass_hash=$3; backend=$4; transport_uid=$5; sudo_uid=$6
[[ $helper_hash =~ ^[a-f0-9]{64}$ && $askpass_hash =~ ^[a-f0-9]{64}$ && $transport_uid =~ ^[1-9][0-9]*$ && $sudo_uid =~ ^[1-9][0-9]*$ && $backend =~ ^[A-Za-z0-9+/]+=*$ ]] || exit 64
[[ $(cat /proc/sys/fs/suid_dumpable) == 0 ]] || { echo 'Requires fs.suid_dumpable=0; no policy is changed by installer.' >&2; exit 78; }
getent passwd "$transport_uid" >/dev/null
getent passwd "$sudo_uid" >/dev/null
[[ ! -e /etc/nanocodex-secure-input/configuration.json ]] || { echo 'Existing enrollment is never overwritten.' >&2; exit 78; }
# Reject mutable or aliased installed ancestors before writing anything. Never
# silently chmod/chown a pre-existing unsafe directory into apparent trust.
protected_directory() {
  local path=$1 owner mode numeric
  [[ -d $path && ! -L $path ]] || return 1
  owner=$(stat -c '%u' -- "$path"); mode=$(stat -c '%a' -- "$path")
  numeric=$((8#$mode))
  [[ $owner == 0 && $((numeric & 0022)) == 0 ]]
}
for directory in / /etc /usr; do protected_directory "$directory" || exit 78; done
if [[ -e /usr/libexec || -L /usr/libexec ]]; then protected_directory /usr/libexec || exit 78; fi
if [[ -e /etc/nanocodex-secure-input || -L /etc/nanocodex-secure-input ]]; then
  protected_directory /etc/nanocodex-secure-input || exit 78
fi
[[ ! -L /etc/nanocodex-secure-input/configuration.json ]] || exit 78
# Copy into root-private staging BEFORE verifying, eliminating user-source races.
staging=$(mktemp -d /etc/.nanocodex-install.XXXXXX)
trap 'rm -rf "$staging"' EXIT
cp -- "$release/nanocodex-secure-input" "$staging/helper"
cp -- "$release/nanocodex-secure-askpass" "$staging/askpass"
[[ $(sha256sum "$staging/helper" | cut -d' ' -f1) == "$helper_hash" && $(sha256sum "$staging/askpass" | cut -d' ' -f1) == "$askpass_hash" ]] || exit 78
[[ ! -L /usr/libexec ]] || exit 78
install -d -o root -g root -m 0755 /usr/libexec
install -o root -g root -m 0755 "$staging/helper" /usr/libexec/nanocodex-secure-input
install -o root -g root -m 4755 "$staging/askpass" /usr/libexec/nanocodex-secure-askpass
# The independently verified backend key and fixed transport-to-authentication UID pair are pinned by root.
# Printed helper PUBLIC identity must be enrolled out-of-band in account backend.
/usr/libexec/nanocodex-secure-input --enroll "$backend" "$transport_uid" "$sudo_uid"
echo 'Pin the preceding helper PUBLIC identity independently; do NOT obtain it from Hand output.'
# Service remains disabled until the administrator has completed backend pinning.
echo 'After out-of-band pinning, install the reviewed resources/nanocodex-secure-input.service into /etc/systemd/system, then enable/start it locally.'
