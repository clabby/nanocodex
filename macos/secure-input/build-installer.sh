#!/bin/bash
# Build only. This script never installs, runs sudo, or modifies live security.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'Usage: build-installer.sh "Developer ID Application: …" "Developer ID Installer: …" SERVER_P256_X963_PUBLIC_KEY_BASE64' >&2
  exit 64
fi
application_identity=$1
installer_identity=$2
approval_public_key=$3
case "$approval_public_key" in *[!A-Za-z0-9+/=]*|'') echo 'Invalid public key encoding' >&2; exit 64;; esac
package_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$package_dir/../.." && pwd)
output_dir="$repo_dir/output/secure-input-native/installer"
mkdir -p "$output_dir"
staging_dir=$(mktemp -d "$repo_dir/output/secure-input-native/package.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT
mkdir -p "$output_dir" "$staging_dir/root/Library/PrivilegedHelperTools" "$staging_dir/root/Library/LaunchDaemons" "$staging_dir/scripts"
swift build --package-path "$package_dir" -c release
binary_dir=$(swift build --package-path "$package_dir" -c release --show-bin-path)
for component in secure-input-helper secure-askpass; do
  if [[ "$component" == secure-input-helper ]]; then installed_name=secure-input; else installed_name=secure-askpass; fi
  destination="$staging_dir/root/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.$installed_name"
  cp "$binary_dir/nanocodex-$component" "$destination"
  codesign --force --options runtime --timestamp --identifier "xyz.paradigm.nanocodex.$installed_name" --sign "$application_identity" "$destination"
  codesign --verify --strict --verbose=2 "$destination"
  chmod 755 "$destination"
done
cp "$package_dir/Resources/xyz.paradigm.nanocodex.secure-input.plist" "$staging_dir/root/Library/LaunchDaemons/"
printf '%s\n' "$approval_public_key" > "$staging_dir/scripts/approval-public-key.txt"
cat > "$staging_dir/scripts/postinstall" <<'POSTINSTALL'
#!/bin/bash
set -euo pipefail
[[ "$3" == / ]] || exit 64
helper=/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-input
askpass=/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-askpass
plist=/Library/LaunchDaemons/xyz.paradigm.nanocodex.secure-input.plist
chown root:wheel "$helper" "$askpass" "$plist"
chmod 755 "$helper"
chmod 4755 "$askpass"
chmod 644 "$plist"
approval_key=$(cat "$(dirname "$0")/approval-public-key.txt")
if [[ ! -e '/Library/Application Support/NanocodexSecureInput/configuration.json' ]]; then
  "$helper" --enroll "$approval_key"
else
  # Existing enrollment is never replaced by a package upgrade.
  "$helper" --identity
fi
launchctl bootout system/xyz.paradigm.nanocodex.secure-input >/dev/null 2>&1 || true
launchctl bootstrap system "$plist"
POSTINSTALL
chmod 755 "$staging_dir/scripts/postinstall"
pkgbuild --root "$staging_dir/root" --scripts "$staging_dir/scripts" --ownership recommended --identifier xyz.paradigm.nanocodex.secure-input --version 1.0.0 --sign "$installer_identity" "$output_dir/NanocodexSecureInput.pkg"
printf 'Built installer: %s\n' "$output_dir/NanocodexSecureInput.pkg"
