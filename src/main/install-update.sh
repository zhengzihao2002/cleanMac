#!/bin/bash
# Finish an update after the running process exits. Keep the old bundle for
# recovery, and restore it if installation, verification or launching fails.
set -eu
source_app="$1"
installed_app="$2"
backup_app="$3"
parent_pid="$4"

case "$source_app" in /*.app) ;; *) exit 1 ;; esac
case "$installed_app" in /*.app) ;; *) exit 1 ;; esac
[ "$source_app" != "$installed_app" ] || exit 1
[ ! -L "$source_app" ] && [ ! -L "$installed_app" ] || exit 1
[ -d "$source_app" ] && [ -d "$installed_app" ] && [ ! -e "$backup_app" ] || exit 1

for ((attempt=0; attempt<600; attempt++)); do
  kill -0 "$parent_pid" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$parent_pid" 2>/dev/null; then
  echo 'Update cancelled: the old app did not quit.'
  exit 1
fi

/bin/mv "$installed_app" "$backup_app"
restore_previous() {
  if [ -e "$installed_app" ]; then /bin/mv "$installed_app" "$backup_app.failed"; fi
  /bin/mv "$backup_app" "$installed_app"
  /usr/bin/open -n "$installed_app" || true
  echo 'Update failed; the previous app was restored.'
  exit 1
}
/bin/mv "$source_app" "$installed_app" || restore_previous
/usr/bin/codesign --verify --deep --strict "$installed_app" || restore_previous
/usr/bin/open -n "$installed_app" || restore_previous
echo 'Update installed at the original application path.'
