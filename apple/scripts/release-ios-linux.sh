#!/usr/bin/env bash
# Local build and sign orchestration; publication remains explicit and separate.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'Linux required' >&2; exit 2; }
case ${1:-} in
  --help|-h|'')
    echo 'Usage: release-ios-linux.sh build-unsigned | build-signed | stage [publish-ios-linux.py arguments]'
    echo 'No GitHub Actions, downloads, auth changes or implicit deployment.'
    echo 'Signing requires pre-provisioned local Linux signing inputs; see sign-ios-linux.sh --help.'
    exit 0;;
  build-unsigned) shift; [[ $# == 0 ]] || exit 2; exec bash "$root/apple/scripts/build-ios-linux.sh";;
  build-signed) shift; [[ $# == 0 ]] || exit 2; exec bash "$root/apple/scripts/build-ios-linux.sh" --sign;;
  stage) shift; exec python3 "$root/apple/scripts/publish-ios-linux.py" "$@";;
  *) echo 'Unknown operation; see --help' >&2; exit 2;;
esac
