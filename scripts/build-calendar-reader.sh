#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
source_file="$repo_root/native/calendar-reader/main.swift"
info_plist="$repo_root/native/calendar-reader/Info.plist"
app="$repo_root/bin/Eink Calendar Reader.app"
output="$app/Contents/MacOS/eink-calendar-reader"
module_cache="${TMPDIR:-/private/tmp}/eink-wallpaper-swift-module-cache"

mkdir -p "$app/Contents/MacOS" "$module_cache"
cp "$info_plist" "$app/Contents/Info.plist"
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
codesign --force --sign - --identifier com.phamous.eink-wallpaper.calendar-reader "$app"
echo "Built $output"
echo "Calendar authorization must be renewed after rebuilding: eink-wallpaper authorize local"
