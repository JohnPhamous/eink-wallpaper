#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
source_file="$repo_root/native/calendar-reader/main.swift"
info_plist="$repo_root/native/calendar-reader/Info.plist"
output="$repo_root/bin/eink-calendar-reader"
module_cache="${TMPDIR:-/private/tmp}/eink-wallpaper-swift-module-cache"

mkdir -p "$repo_root/bin" "$module_cache"
xcrun swiftc \
  -parse-as-library \
  -module-cache-path "$module_cache" \
  -framework EventKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$info_plist" \
  "$source_file" \
  -o "$output"
codesign --force --sign - --identifier com.phamous.eink-wallpaper.calendar-reader "$output"
echo "Built $output"
