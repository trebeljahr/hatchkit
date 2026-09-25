#!/usr/bin/env bash
#
# Build → install → launch → screenshot, from a shell, without a GUI and
# without ever taking focus from whoever is using the machine.
#
#   bash scripts/mobile-headless.sh ios     [--no-build] [--erase]
#   bash scripts/mobile-headless.sh android [--no-build] [--erase]
#
# This is the agent-safe loop and the one to reach for when verifying a
# change. `pnpm dev:ios` / `pnpm dev:android` are for a person iterating on
# UI, and `cap open` is for a person archiving a release.
#
# Env:
#   NEXT_PUBLIC_API_URL   required — baked into the bundle (see below)
#   SIM=<device name>     iOS simulator to use (default: first available iPhone)
#   AVD=<name>            Android AVD to boot when nothing is attached
#   API_PORT=<n>          used for the Android `adb reverse` forward
#   SHOT=<path>           screenshot destination (default: ./mobile-shot.png)
#
# ── Why the loop looks like this ──────────────────────────────────────
#
# iOS
#   · DO NOT pass CODE_SIGNING_ALLOWED=NO. Without the ad-hoc signature
#     Xcode applies by default for the simulator SDK, every Keychain call
#     fails with `errSecMissingEntitlement` (OS error -34018). A token is
#     then never stored, the app silently falls back to whatever second
#     credential exists, and the bearer path looks fine while being
#     entirely untested.
#   · The Simulator's WKWebView DOES send cookies to http://localhost:<port>,
#     and its cookie store survives `simctl uninstall`. So cookie auth can
#     appear to work from capacitor://localhost and mask a broken bearer
#     path. `xcrun simctl erase` (--erase here) is the only reliable clean
#     slate; the real tell is on the server, where a request from the app
#     must arrive with NO Cookie header at all.
#   · `simctl` alone never shows the software keyboard. The Simulator
#     counts the Mac's keyboard as connected until Simulator.app itself has
#     read `ConnectHardwareKeyboard=false`, so a headless loop screenshots
#     a focused field with no keyboard under it and nothing about the
#     layout is being tested. This script writes the default and then opens
#     Simulator.app with `open -g` — BACKGROUND. A plain `open -a`
#     activates it and takes keyboard focus from the person at the Mac.
#
# Android
#   · A bundled build's document origin is https://localhost, and a fetch
#     from an https document to a plain-http one is blocked as mixed
#     content unless the target is a loopback address. So bake
#     http://localhost:<API_PORT> and `adb reverse` that port. 10.0.2.2
#     works for live reload, where the document is itself http, but not for
#     the bundle.
#   · `adb shell input text` is split by the DEVICE's shell, so only the
#     first word of "two words" arrives. Use %s for spaces.
#   · The FIRST back press with a dialog open is eaten by the IME whenever
#     a field is focused — `adb shell dumpsys input_method | grep mInputShown`
#     says so — even with no on-screen keyboard visible, because a hardware
#     keyboard is attached. That is Android's own ordering, not a bug in
#     the overlay stack. Press back twice, or check mInputShown first.
#   · The emulator boots with -no-window, so nothing appears on screen.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

PLATFORM="${1:-}"
shift || true
DO_BUILD=1
DO_ERASE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --erase) DO_ERASE=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

SHOT="${SHOT:-$REPO/mobile-shot.png}"

if [ "$PLATFORM" != "ios" ] && [ "$PLATFORM" != "android" ]; then
  echo "Usage: bash scripts/mobile-headless.sh ios|android [--no-build] [--erase]" >&2
  exit 1
fi

if [ -z "${NEXT_PUBLIC_API_URL:-}" ]; then
  echo "NEXT_PUBLIC_API_URL is required — it is baked into the bundle." >&2
  echo "  ios:     NEXT_PUBLIC_API_URL=http://localhost:<API_PORT>" >&2
  echo "  android: NEXT_PUBLIC_API_URL=http://localhost:<API_PORT>  (then adb reverse)" >&2
  exit 1
fi

read_app_id() {
  node -e '
    const fs = require("node:fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const m = src.match(/appId:\s*["'"'"'`]([^"'"'"'`]+)/);
    if (!m) { process.exit(1); }
    process.stdout.write(m[1]);
  ' "$REPO/capacitor.config.ts"
}
APP_ID="$(read_app_id)"

# ── iOS ───────────────────────────────────────────────────────────────
if [ "$PLATFORM" = "ios" ]; then
  SIM_NAME="${SIM:-}"
  if [ -n "$SIM_NAME" ]; then
    UDID=$(xcrun simctl list devices available | grep -F "$SIM_NAME" | head -1 \
      | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')
  else
    UDID=$(xcrun simctl list devices available | grep -E '^\s+iPhone ' | head -1 \
      | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')
  fi
  if [ -z "$UDID" ]; then
    echo "No available iPhone simulator found. xcrun simctl list devices available" >&2
    exit 1
  fi

  if [ "$DO_ERASE" = "1" ]; then
    echo "Erasing $UDID (the only reliable clean slate — the cookie store survives uninstall)"
    xcrun simctl shutdown "$UDID" 2>/dev/null || true
    xcrun simctl erase "$UDID"
  fi

  xcrun simctl boot "$UDID" 2>/dev/null || true
  # Software keyboard: the default has to be written before Simulator.app
  # reads it, and Simulator.app has to run at least once for simctl's
  # keyboard behaviour to match a real device. `-g` keeps it in the
  # background so it never steals focus.
  defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false || true
  open -g -a Simulator || true

  if [ "$DO_BUILD" = "1" ]; then
    (cd "$REPO" && node scripts/build-mobile.mjs ios)
  fi

  DD="${DERIVED_DATA:-$REPO/.derived-data}"
  echo "Building App.xcodeproj (Debug, iphonesimulator) → $DD"
  # No CODE_SIGNING_ALLOWED=NO — see the header.
  (cd "$REPO/ios/App" && xcodebuild \
      -project App.xcodeproj \
      -scheme App \
      -configuration Debug \
      -sdk iphonesimulator \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DD" \
      build)

  APP="$DD/Build/Products/Debug-iphonesimulator/App.app"
  xcrun simctl install "$UDID" "$APP"
  xcrun simctl launch "$UDID" "$APP_ID"
  sleep 2
  xcrun simctl io "$UDID" screenshot --type=png "$SHOT"
  echo "Screenshot: $SHOT"
  echo "Logs: xcrun simctl spawn $UDID log stream --predicate 'process == \"App\"'"
  exit 0
fi

# ── Android ───────────────────────────────────────────────────────────
# shellcheck disable=SC1091
[ -f "$HERE/android-env.sh" ] && source "$HERE/android-env.sh"

AVD_NAME="${AVD:-}"
ATTACHED=$(adb devices | awk 'NR>1 && $2 == "device" { print $1; exit }')
if [ -z "$ATTACHED" ]; then
  if [ -z "$AVD_NAME" ]; then
    AVD_NAME=$(emulator -list-avds | head -1)
  fi
  if [ -z "$AVD_NAME" ]; then
    echo "No device attached and no AVD available. Create one, or set AVD=<name>." >&2
    exit 1
  fi
  echo "Booting $AVD_NAME with -no-window (nothing appears on screen)"
  nohup emulator -avd "$AVD_NAME" -no-window -no-boot-anim -no-audio \
      -gpu swiftshader_indirect -memory 2048 \
    > /tmp/mobile-headless-emulator.log 2>&1 &
  disown
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 1
  done
  ATTACHED=$(adb devices | awk 'NR>1 && $2 == "device" { print $1; exit }')
fi
echo "Device: $ATTACHED"

if [ "$DO_ERASE" = "1" ]; then
  adb -s "$ATTACHED" uninstall "$APP_ID" 2>/dev/null || true
fi

# Mixed content: the bundle's origin is https://localhost, so the API has
# to be a loopback address from the device's point of view.
if [ -n "${API_PORT:-}" ]; then
  adb -s "$ATTACHED" reverse "tcp:$API_PORT" "tcp:$API_PORT"
  echo "adb reverse tcp:$API_PORT -> host"
fi

if [ "$DO_BUILD" = "1" ]; then
  (cd "$REPO" && node scripts/build-mobile.mjs android)
fi

(cd "$REPO/android" && ./gradlew --console=plain :app:assembleDebug)
APK="$REPO/android/app/build/outputs/apk/debug/app-debug.apk"
adb -s "$ATTACHED" install -r "$APK"
adb -s "$ATTACHED" shell am start -n "$APP_ID/.MainActivity"
sleep 2
adb -s "$ATTACHED" exec-out screencap -p > "$SHOT"
echo "Screenshot: $SHOT"
echo "Logs:      adb -s $ATTACHED logcat -s Capacitor:V chromium:V"
echo "Keyboard:  adb -s $ATTACHED shell dumpsys input_method | grep mInputShown"
echo "Type text: adb -s $ATTACHED shell input text 'two%swords'   (%s, not a space)"
