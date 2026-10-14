#!/bin/bash
#
# Runs cleanMac's tests with the Node.js that is built into cleanMac.app,
# so nothing extra needs to be installed. Build the app first (./build.sh).

if [ -z "${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$ROOT/cleanMac.app/Contents/MacOS/cleanMac"

if [ ! -x "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    echo "Build the app first: ./build.sh --no-open" >&2
    exit 1
  fi
fi

export ELECTRON_RUN_AS_NODE=1
"$NODE" "$ROOT/test/run.js"
status=$?
rm -rf "$ROOT/.runtime/test"
exit $status
