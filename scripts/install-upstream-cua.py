#!/usr/bin/env python3
"""Retired copy-only CUA launcher; never select a host requiring Codex.

The signed native helper needs the managed no-Codex lifecycle/policy host.
Copying cua_node alone is not an equivalent installation. Use the shared
native provisioning command instead, or the explicit Linux Sky installer.
"""
import sys

if __name__ == '__main__':
    print('The copy-only CUA installer is retired. Use `nanocodex computer setup` '
          '(macOS; Windows upstream support is unavailable) or '
          '`scripts/install-linux-sky-host.py` (Linux). '
          'No files or provider selections were changed.', file=sys.stderr)
    sys.exit(2)
