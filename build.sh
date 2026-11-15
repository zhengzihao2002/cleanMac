#!/bin/bash
#
# Builds cleanMac.app on this Mac.
#
#   ./build.sh                  build cleanMac.app, then open it
#   ./build.sh --no-open        build only
#   ./build.sh --keep-download  keep the downloaded runtime (faster rebuilds)
#   ./build.sh --clean          remove everything the build created
#
# Everything is downloaded into this folder (.runtime/) and the app is created
# in this folder (cleanMac.app). Nothing is installed anywhere else, so
# deleting this folder removes cleanMac completely.

# Re-run with bash if started from sh/zsh.
if [ -z "${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_NAME="cleanMac"
BUNDLE_ID="local.cleanmac.app"

# The Electron runtime (Chromium + Node.js) the app runs on, pinned to an
# exact release and verified against its published SHA-256 checksum.
ELECTRON_VERSION="44.7.2"
SHA256_ARM64="07d73d3d6dd0b8679c2f1849e30df179ea50c1d6b17630fcc398ae05221f0bd2"
SHA256_X64="915cb638692e3595926fa64903ee0562c3c0c5a1febb84724175756ca2f0f3b7"
MIN_MACOS_MAJOR=13

RUNTIME="$ROOT/.runtime"
DOWNLOADS="$RUNTIME/downloads"
STAGE="$RUNTIME/stage"
APP="$ROOT/$APP_NAME.app"

# Keep every temporary file of the build inside this folder too.
BUILD_LAUNCH_TMPDIR="${TMPDIR:-/tmp}"
export TMPDIR="$RUNTIME/tmp/"

OPEN_APP=1
KEEP_DOWNLOAD=0
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_APP=0 ;;
    --keep-download) KEEP_DOWNLOAD=1 ;;
    --clean)
      rm -rf "$RUNTIME" "$APP"
      echo "Removed .runtime/ and $APP_NAME.app."
      exit 0
      ;;
    -h | --help)
      sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------- output

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; D=""; G=""; R=""; C=""; N=""
fi
step() { printf '%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
info() { printf '    %s%s%s\n' "$D" "$*" "$N"; }
fail() {
  printf '\n%sError:%s %s\n' "$R$B" "$N" "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$STAGE" "$RUNTIME/tmp"
}
trap cleanup EXIT

printf '\n  %scleanMac%s  %sbuilding on this Mac — everything stays in %s%s\n\n' "$B" "$N" "$D" "$ROOT" "$N"

# ---------------------------------------------------------------- checks

[ "$(uname -s)" = "Darwin" ] || fail "cleanMac can only be built on macOS."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [ "$MACOS_MAJOR" -lt "$MIN_MACOS_MAJOR" ]; then
  fail "cleanMac needs macOS $MIN_MACOS_MAJOR (Ventura) or newer. This Mac runs macOS $MACOS_VERSION."
fi

for tool in curl ditto shasum codesign plutil xattr; do
  command -v "$tool" >/dev/null 2>&1 || fail "Missing the macOS tool '$tool'."
done

if pgrep -f "$APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then
  fail "cleanMac is running. Quit it first, then run ./build.sh again."
fi
if [ "${CLEANMAC_UPDATER_BUILD:-0}" != 1 ] && pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  fail "Another copy of cleanMac is running. Quit every cleanMac window before rebuilding."
fi

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
  EXPECTED_SHA="$SHA256_ARM64"
else
  ARCH="x64"
  EXPECTED_SHA="$SHA256_X64"
fi

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
[ -n "$VERSION" ] || VERSION="1.0.0"

info "macOS $MACOS_VERSION · $( [ "$ARCH" = arm64 ] && echo 'Apple silicon' || echo 'Intel' ) · cleanMac $VERSION"

mkdir -p "$DOWNLOADS" "$RUNTIME/tmp"

# ------------------------------------------------------------- download

ZIP_NAME="electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip"
ZIP="$DOWNLOADS/$ZIP_NAME"
URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}"

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

if [ -f "$ZIP" ] && [ "$(sha_of "$ZIP")" = "$EXPECTED_SHA" ]; then
  step "Using the runtime already downloaded"
else
  step "Downloading the app runtime (Electron $ELECTRON_VERSION, about 130 MB)"
  info "$URL"
  rm -f "$ZIP" "$ZIP.part"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 --progress-bar -o "$ZIP.part" "$URL" \
    || fail "Download failed. Check your internet connection and run ./build.sh again."
  mv "$ZIP.part" "$ZIP"
fi

step "Verifying the download"
ACTUAL_SHA="$(sha_of "$ZIP")"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  rm -f "$ZIP"
  fail "Checksum mismatch — the download is corrupt or was tampered with. Nothing was installed."
fi
info "SHA-256 $ACTUAL_SHA ✓"

# ------------------------------------------------------------- assemble

step "Assembling $APP_NAME.app"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto -x -k "$ZIP" "$STAGE"
[ -d "$STAGE/Electron.app" ] || fail "The runtime archive did not contain Electron.app."

BUNDLE="$STAGE/$APP_NAME.app"
mv "$STAGE/Electron.app" "$BUNDLE"
mv "$BUNDLE/Contents/MacOS/Electron" "$BUNDLE/Contents/MacOS/$APP_NAME"
rm -f "$BUNDLE/Contents/Resources/default_app.asar" "$BUNDLE/Contents/Resources/electron.icns"
cp "$ROOT/assets/cleanMac.icns" "$BUNDLE/Contents/Resources/cleanMac.icns"

# The interface is in English; drop Chromium's other UI translations (~50 MB).
for dir in "$BUNDLE/Contents/Resources" "$BUNDLE/Contents/Frameworks/Electron Framework.framework/Resources"; do
  for lproj in "$dir"/*.lproj; do
    case "$(basename "$lproj")" in
      en.lproj | en_GB.lproj | Base.lproj) ;;
      *) rm -rf "$lproj" ;;
    esac
  done
done

PLIST="$BUNDLE/Contents/Info.plist"
set_string() { plutil -replace "$1" -string "$2" "$PLIST"; }
remove_key() { plutil -remove "$1" "$PLIST" >/dev/null 2>&1 || true; }

set_string CFBundleExecutable "$APP_NAME"
set_string CFBundleName "$APP_NAME"
set_string CFBundleDisplayName "$APP_NAME"
set_string CFBundleIdentifier "$BUNDLE_ID"
set_string CFBundleIconFile "cleanMac.icns"
set_string CFBundleShortVersionString "$VERSION"
set_string CFBundleVersion "$VERSION"
set_string LSApplicationCategoryType "public.app-category.utilities"
set_string NSHumanReadableCopyright "Built on this Mac from source. Runs offline."
# cleanMac never uses the network, camera, microphone or Bluetooth.
for key in ElectronAsarIntegrity NSAppTransportSecurity NSCameraUsageDescription NSMicrophoneUsageDescription \
  NSAudioCaptureUsageDescription NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription; do
  remove_key "$key"
done
plutil -lint "$PLIST" >/dev/null || fail "Info.plist is invalid."

APP_DIR="$BUNDLE/Contents/Resources/app"
mkdir -p "$APP_DIR"
cp "$ROOT/package.json" "$APP_DIR/package.json"
ditto "$ROOT/src" "$APP_DIR/src"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
SOURCE_COMMIT="${CLEANMAC_SOURCE_COMMIT:-}"
if [ -z "$SOURCE_COMMIT" ] && [ -d "$ROOT/.git" ]; then
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
if [ -z "$SOURCE_COMMIT" ] && [ -f "$ROOT/.source-commit" ]; then
  ARCHIVE_COMMIT="$(tr -d '\r\n' < "$ROOT/.source-commit")"
  if [[ "$ARCHIVE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then SOURCE_COMMIT="$ARCHIVE_COMMIT"; fi
fi
cat >"$APP_DIR/build-info.json" <<EOF
{
  "sourceCommit": "$(json_escape "$SOURCE_COMMIT")",
  "projectRoot": "$(json_escape "$ROOT")",
  "updateRoot": "$(json_escape "${CLEANMAC_UPDATE_ROOT:-$ROOT/.runtime/updates}")",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "electron": "$ELECTRON_VERSION",
  "arch": "$ARCH"
}
EOF

# ------------------------------------------------------------------ sign

step "Signing locally (ad-hoc)"
info "No Apple developer account needed: the app is signed for this Mac only."
xattr -cr "$BUNDLE"
codesign --force --deep --sign - "$BUNDLE" >"$RUNTIME/tmp/codesign.log" 2>&1 \
  || { cat "$RUNTIME/tmp/codesign.log" >&2; fail "Code signing failed."; }
codesign --verify --deep --strict "$BUNDLE" >"$RUNTIME/tmp/verify.log" 2>&1 \
  || { cat "$RUNTIME/tmp/verify.log" >&2; fail "Signature verification failed."; }

# --------------------------------------------------------------- install

rm -rf "$APP"
mv "$BUNDLE" "$APP"
touch "$APP"

if [ "$KEEP_DOWNLOAD" -eq 0 ]; then
  rm -rf "$DOWNLOADS"
else
  info "Kept the runtime download in .runtime/downloads for faster rebuilds."
fi

SIZE="$(du -sh "$APP" | awk '{print $1}')"
printf '\n%s✓ Built %s.app%s %s(%s)%s\n' "$G$B" "$APP_NAME" "$N" "$D" "$SIZE" "$N"
printf '  %s\n\n' "$APP"
printf '  Open it any time by double-clicking %s.app in this folder.\n' "$APP_NAME"
printf '  To remove cleanMac completely: run ./uninstall.sh, or just delete this folder.\n\n'

if [ "$OPEN_APP" -eq 1 ]; then
  TMPDIR="$BUILD_LAUNCH_TMPDIR" open -n "$APP"
fi
