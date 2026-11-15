#!/bin/sh
# cleanMac administrator helper.
#
# Runs as root only after you approve the macOS password dialog. It reads a
# plan file written by cleanMac and removes ONLY what is listed there, and only
# when it is inside /Library/Caches, /Library/Logs or /private/var/log (or is a
# Time Machine local snapshot). Every path is re-validated here, independently
# of the app.
#
# Plan format, one item per line (tab separated):
#   <id>  contents  <folder>     remove everything inside <folder>
#   <id>  remove    <file>       remove a single file
#   <id>  snapshot  <date>       delete a local Time Machine snapshot

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

PLAN="$1"
TAB="$(printf '\t')"

if [ ! -f "$PLAN" ]; then
  echo "ERR${TAB}-${TAB}Plan file missing"
  exit 1
fi

device_id() {
  if [ "$(uname -s)" = Darwin ]; then
    /usr/bin/stat -f '%d' "$1"
  else
    /usr/bin/stat -c '%d' "$1"
  fi
}

allowed() {
  p="$1"
  op="$2"
  case "$p" in
    */ | *"/../"* | *"/./"* | *"/.." | *"/." | *"//"* | *"$TAB"*) return 1 ;;
  esac
  case "$p" in
    /Library/Caches/?* | /Library/Logs/?*) ;;
    /private/var/log/?*)
      # System log directories and live files are never clean-up targets.
      [ "$op" = remove ] || return 1
      rel="${p#/private/var/log/}"
      case "$rel" in */*/*) return 1 ;; esac
      printf '%s\n' "$rel" | /usr/bin/grep -Eiq '\.(gz|bz2|xz|zip|[0-9]+)$' || return 1
      ;;
    *) return 1 ;;
  esac
  # The item itself must not be a symbolic link …
  [ -L "$p" ] && return 1
  # … and neither may any folder on the way to it.
  dir="$(dirname "$p")"
  real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  [ "$real" = "$dir" ] || return 1
  # -xdev does not protect a selected root that is itself a mount: it would
  # treat that mounted device as its baseline. Refuse the root as well.
  if [ -e "$p" ]; then
    parent_device="$(device_id "$dir")" || return 1
    target_device="$(device_id "$p")" || return 1
    [ "$target_device" = "$parent_device" ] || return 1
  fi
  return 0
}

# Refuse the entire folder if recursive removal would include a protected
# descendant. Do not follow links or descend into mounted filesystems.
safe_tree() {
  blocked="$(find "$1" -xdev \( \
    -ipath '*/Library/Keychains' -o -ipath '*/Library/Preferences' -o \
    -ipath '*/Library/Mobile Documents' -o -ipath '*/Library/CloudStorage' -o \
    -ipath '*/Library/Messages' -o -ipath '*/Library/Mail' -o \
    -ipath '*/Library/Safari' -o -ipath '*/Library/Photos' -o \
    -ipath '*/Library/Accounts' -o -ipath '*/Library/Cookies' -o \
    -ipath '*/Library/Calendars' -o -ipath '*/Library/Keyboard' -o \
    -ipath '*/Library/LaunchAgents' -o -ipath '*/Library/LaunchDaemons' -o \
    -iname '.Trash' -o -iname '*.photoslibrary' -o -iname '*.musiclibrary' -o \
    -iname '*.tvlibrary' -o -iname '*.fcpbundle' -o -iname '*.vmwarevm' -o \
    -iname '*.pvm' -o -iname '*.utm' -o \
    \( -type d -iname '*.app' -exec test -f '{}/Contents/Info.plist' \; \) \
    \) -print -quit 2>/dev/null)" || return 1
  [ -z "$blocked" ]
}

ok() { echo "OK${TAB}$1"; }
err() { echo "ERR${TAB}$1${TAB}$2"; }

while IFS="$TAB" read -r id op arg; do
  [ -n "$id" ] || continue
  case "$op" in
    contents)
      if ! allowed "$arg" contents; then
        err "$id" "Refused: not an allowed system location"
      elif [ ! -d "$arg" ]; then
        ok "$id"
      elif ! safe_tree "$arg"; then
        err "$id" "Refused: folder contains protected files or could not be checked"
      else
        # Delete entries without recursive rm so a nested mount is never
        # traversed. Keep the cache/log folder itself.
        find "$arg" -xdev -depth -mindepth 1 ! -type d -exec rm -f {} + 2>/dev/null
        find "$arg" -xdev -depth -mindepth 1 -type d -exec rmdir {} \; 2>/dev/null
        if [ -z "$(ls -A "$arg" 2>/dev/null)" ]; then
          ok "$id"
        else
          err "$id" "macOS protects some of these files, so they were left in place."
        fi
      fi
      ;;
    remove)
      if ! allowed "$arg" remove; then
        err "$id" "Refused: not an allowed system location"
      elif [ ! -e "$arg" ]; then
        ok "$id"
      elif [ -f "$arg" ] && rm -f "$arg" 2>/dev/null; then
        ok "$id"
      else
        err "$id" "Could not remove a system log file."
      fi
      ;;
    snapshot)
      case "$arg" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9])
          if tmutil deletelocalsnapshots "$arg" >/dev/null 2>&1; then
            ok "$id"
          else
            err "$id" "macOS did not delete this snapshot (it may be in use by a backup)."
          fi
          ;;
        *) err "$id" "Refused: invalid snapshot name" ;;
      esac
      ;;
    *)
      err "$id" "Refused: unknown operation"
      ;;
  esac
done < "$PLAN"

exit 0
