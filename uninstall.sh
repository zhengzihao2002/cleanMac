#!/bin/bash
#
# Removes everything cleanMac may have left outside this folder, then offers
# to move this folder to the Trash.
#
# cleanMac keeps its own files inside this folder and erases its temporary
# data when it quits, so normally there is very little to do. This script also
# clears the bookkeeping macOS itself keeps about any app you have opened
# (the Full Disk Access entry, the Launch Services record, window state).

if [ -z "${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP="$ROOT/cleanMac.app"
ID="local.cleanmac.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

[ "$(uname -s)" = "Darwin" ] || { echo "This script is for macOS."; exit 1; }

say() { printf '  • %s\n' "$*"; }
ask() {
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

echo
echo "Removing cleanMac traces outside $ROOT"
echo

if pgrep -f "$APP/Contents/MacOS/cleanMac" >/dev/null 2>&1; then
  osascript -e "tell application id \"$ID\" to quit" >/dev/null 2>&1 || true
  sleep 2
  say "Quit cleanMac"
fi

remove() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    rm -rf "$1"
    say "Removed $1"
  fi
}

remove "$HOME/Library/Saved Application State/$ID.savedState"
remove "$HOME/Library/Caches/$ID"
remove "$HOME/Library/HTTPStorages/$ID"
remove "$HOME/Library/HTTPStorages/$ID.binarycookies"
remove "$HOME/Library/WebKit/$ID"
remove "$HOME/Library/Preferences/$ID.plist"

USER_CACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || true)"
USER_TEMP="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
[ -n "$USER_CACHE" ] && remove "${USER_CACHE}$ID"
[ -n "$USER_TEMP" ] && remove "${USER_TEMP}$ID"
if [ -n "$USER_TEMP" ]; then
  for dir in "${USER_TEMP}"cleanmac-session-*; do
    [ -e "$dir" ] && remove "$dir"
  done
fi

for report in "$HOME"/Library/Logs/DiagnosticReports/cleanMac*; do
  [ -e "$report" ] && remove "$report"
done

if defaults read "$ID" >/dev/null 2>&1; then
  defaults delete "$ID" >/dev/null 2>&1 && say "Removed preference domain $ID"
fi

if security find-generic-password -s "cleanMac Safe Storage" >/dev/null 2>&1; then
  security delete-generic-password -s "cleanMac Safe Storage" >/dev/null 2>&1 && say "Removed keychain item “cleanMac Safe Storage”"
fi

tccutil reset All "$ID" >/dev/null 2>&1 && say "Reset privacy permissions for this user"

if [ -d "$APP" ]; then
  "$LSREGISTER" -u "$APP" >/dev/null 2>&1 && say "Unregistered cleanMac.app from Launch Services"
fi

echo
echo "If you gave cleanMac Full Disk Access, macOS keeps that entry in a"
echo "system-wide list. Clearing it needs your administrator password"
echo "(you can also remove it in System Settings → Privacy & Security → Full Disk Access)."
if ask "Clear the Full Disk Access entry now?"; then
  sudo tccutil reset SystemPolicyAllFiles "$ID" && say "Cleared the Full Disk Access entry"
fi

echo
if [ -f "$ROOT/build.sh" ] && [ -f "$ROOT/src/main/main.js" ] && [ "$ROOT" != "$HOME" ] && [ "$ROOT" != "/" ]; then
  if ask "Move the cleanMac folder ($ROOT) to the Trash too?"; then
    DEST="$HOME/.Trash/$(basename "$ROOT") $(date +%Y-%m-%d\ %H.%M.%S)"
    cd / && mv "$ROOT" "$DEST" && say "Moved the cleanMac folder to the Trash. Empty the Trash to free the space."
  else
    echo "Done. Delete the folder whenever you like:"
    echo "  $ROOT"
  fi
fi
echo
