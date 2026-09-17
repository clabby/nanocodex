#!/bin/bash
# Explicit local operator step. Does not reboot or restart the graphical session.
set -euo pipefail
[ "${1:-}" = --activate ] || { echo 'Usage: sudo ./install-omarchy.sh --activate'; exit 64; }
[ "$EUID" = 0 ] || { echo 'Administrator access is required to update the Hand service.'; exit 1; }
stage=$(cd -- "$(dirname -- "$0")" && pwd)
root=/opt/nanocodex/background-cua
for f in nanocodex2 nanocodex-computer nanocodex-hyprland-capture cua-hyprland-plugin.so compositor-version.json desktop-companion hand-companion activate-plugin.py; do
  [ -f "$stage/$f" ] || { echo "Missing validated artifact: $f"; exit 1; }
done
(cd "$stage" && sha256sum -c SHA256SUMS)
[ ! -e "$root" ] || { echo 'Existing background CUA installation needs explicit review; no automatic replacement.'; exit 1; }
install -d -m 755 "$root"
for f in nanocodex2 nanocodex-computer nanocodex-hyprland-capture cua-hyprland-plugin.so desktop-companion hand-companion activate-plugin.py; do install -m 755 "$stage/$f" "$root/$f"; done
install -m 644 "$stage/compositor-version.json" "$root/compositor-version.json"
printf '%s\n' 'nanocodex ALL=(gakonst) NOPASSWD: /opt/nanocodex/background-cua/desktop-companion --allow-native-control serve' > "$root/sudoers"
chmod 440 "$root/sudoers"
visudo -cf "$root/sudoers"
install -m 440 "$root/sudoers" /etc/sudoers.d/nanocodex-background-cua
# This acts only on the desktop user's sole compositor and refuses replacement.
runuser -u gakonst -- "$root/activate-plugin.py"
install -d -m 755 /etc/systemd/system/nanocodex-hand.service.d
cat > /etc/systemd/system/nanocodex-hand.service.d/99-background-cua.conf <<'UNIT'
[Service]
Environment=NANOCODEX_COMPUTER=/opt/nanocodex/background-cua/hand-companion
Environment=NANOCODEX_COMPUTER_BACKGROUND=hyprland
ExecStart=
ExecStart=/opt/nanocodex/background-cua/nanocodex2 hand --workspace /srv/nanocodex/workspace --state-dir /srv/nanocodex/native-state --machine-name omarchy-desktop --vm-provider omarchy-desktop --log-format json
UNIT
systemctl daemon-reload
systemctl restart nanocodex-hand.service
systemctl --no-pager is-active nanocodex-hand.service
printf '%s\n' 'Hand enabled. Reselect omarchy-desktop and verify cua.getApp while the human screen remains in use.' 'The companion reactivates the verified plugin on first use after a compositor restart; version changes require rebuilding.'
