#!/bin/bash
set -euo pipefail
APP="$1"
ENTITLEMENTS="$(cd "$(dirname "$0")" && pwd)/entitlements.mac.plist"
[[ "$(uname -s)" == "Darwin" ]] || { printf 'Signing requires macOS.\n'; exit 1; }
while IFS= read -r -d '' binary; do
  if /usr/bin/file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    /usr/bin/codesign --force --sign - "$binary"
  fi
done < <(/usr/bin/find "$APP/Contents" -type f -print0)
/usr/bin/codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
