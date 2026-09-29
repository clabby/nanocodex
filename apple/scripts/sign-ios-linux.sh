#!/usr/bin/env bash
# Linux signing only; private inputs are local paths, never password arguments.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/sign-ios-linux.py" "$@"
