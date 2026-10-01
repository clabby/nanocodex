#!/usr/bin/env bash
# Export from an existing Xcode.app tree; never from an installed artifactbundle.
set -euo pipefail
exec python3 "$(dirname "$0")/xtool-sdk-linux.py" export "$@"
