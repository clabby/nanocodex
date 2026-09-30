#!/usr/bin/env bash
# Verify and stage an exported SDK before replacing the installed bundle.
set -euo pipefail
exec python3 "$(dirname "$0")/xtool-sdk-linux.py" import "$@"
