#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="${1:-$source_dir/../dist}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
program="$output_dir/desk-calendar-availability-v1"
if [[ -e "$program" ]]; then
  echo "Refusing to overwrite an availability reader. Build a new version or use a separate qualification directory." >&2
  exit 1
fi
swiftc -O -o "$program" "$source_dir/availability-reader.swift" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/AvailabilityInfo.plist"
codesign --force --sign - --identifier org.cortex.desk-calendar-availability-v1 --entitlements "$source_dir/entitlements.plist" "$program"
echo "built $program"
