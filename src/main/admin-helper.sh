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

allowed() {
  p="$1"
  case "$p" in
    *"/../"* | *"/./"* | *"/.." | *"/." | *"//"* | *"$TAB"*) return 1 ;;
  esac
  case "$p" in
    /Library/Caches/?* | /Library/Logs/?* | /private/var/log/?*) ;;
    *) return 1 ;;
  esac
  # The item itself must not be a symbolic link …
  [ -L "$p" ] && return 1
  # … and neither may any folder on the way to it.
  dir="$(dirname "$p")"
  real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  [ "$real" = "$dir" ] || return 1
  return 0
}

ok() { echo "OK${TAB}$1"; }
err() { echo "ERR${TAB}$1${TAB}$2"; }

while IFS="$TAB" read -r id op arg; do
  [ -n "$id" ] || continue
  case "$op" in
    contents)
      if ! allowed "$arg"; then
        err "$id" "Refused: not an allowed system location"
      elif [ ! -d "$arg" ]; then
        ok "$id"
      else
        find "$arg" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
        if [ -z "$(ls -A "$arg" 2>/dev/null)" ]; then
          ok "$id"
        else
          err "$id" "macOS protects some of these files, so they were left in place."
        fi
      fi
      ;;
    remove)
      if ! allowed "$arg"; then
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
