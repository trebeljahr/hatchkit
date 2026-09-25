#!/usr/bin/env bash
#
# One-command Android dev loop with live reload.
#
# What this does:
#   1. Source scripts/android-env.sh so JAVA_HOME / ANDROID_HOME are set.
#   2. Boot the emulator if nothing is attached (or use attached device).
#   3. Start Next.js dev server on 0.0.0.0 so the emulator can reach it.
#   4. cap sync with CAP_DEV_URL — capacitor.config.ts injects server.url
#      when that env var is set, making the WebView load from the Next
#      dev server instead of bundled assets.
#   5. cap run android — installs the APK and launches.
#
# Edits to packages/client/src hot-reload on the device in ~500ms.
#
# Env overrides:
#   AVD=<name>       which AVD to boot (default: Medium_Phone_API_35)
#   NEXT_PORT=<n>    Next.js port (default: 3000)
#   LAN_IP=<ip>      override auto-detected LAN IP
#   CAP_DEV_URL=<url> full WebView dev URL override, e.g.
#                     https://<slug>.local.<your-domain>/

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/android-env.sh"

AVD_NAME="${AVD:-Medium_Phone_API_35}"
NEXT_PORT="${NEXT_PORT:-3000}"

# Android emulator NAT reserves 10.0.2.2 as "host loopback".
# For a real device over Wi-Fi, pass LAN_IP=<your-mac-ip>.
DEV_HOST="${LAN_IP:-10.0.2.2}"

NEXT_PID=""

local_dev_url() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    try {
      const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
      const slug = manifest?.localDev?.slug;
      const configuredDomain = manifest?.localDev?.domain;
      const projectDomain = String(manifest?.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const labels = projectDomain.split(".").filter(Boolean);
      const baseDomain = labels.length > 2 ? labels.slice(-2).join(".") : projectDomain;
      const localDevDomain = configuredDomain || (baseDomain ? `local.${baseDomain}` : "local.example.com");
      if (slug) process.stdout.write(`https://${slug}.${localDevDomain}/`);
    } catch {}
  ' "$REPO/.hatchkit.json"
}

cleanup() {
  echo ""
  echo "Stopping Next.js dev server"
  if [ -n "$NEXT_PID" ]; then
    kill -TERM "$NEXT_PID" 2>/dev/null || true
  fi
  sleep 0.3
  lsof -ti:"$NEXT_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  wait 2>/dev/null || true
  echo "   (emulator/phone left running — next dev:android is instant)"
}
trap cleanup EXIT INT TERM

# ── ADB sanity ────────────────────────────────────────────
# Reset adb server to prevent Capacitor retry-race on port 5037.
echo "Resetting adb server"
adb kill-server > /dev/null 2>&1 || true
pkill -9 -f 'adb fork-server' 2>/dev/null || true
pkill -9 -x adb 2>/dev/null || true

PORT_TIMEOUT=10
SECS=0
while lsof -ti:5037 > /dev/null 2>&1; do
  sleep 0.5
  SECS=$((SECS + 1))
  if [ $SECS -ge $((PORT_TIMEOUT * 2)) ]; then
    echo "adb port 5037 still held after ${PORT_TIMEOUT}s."
    exit 1
  fi
done

adb start-server > /dev/null 2>&1

# Clear stale Next.js on port
if lsof -ti:"$NEXT_PORT" > /dev/null 2>&1; then
  echo "Clearing stale process on port $NEXT_PORT"
  lsof -ti:"$NEXT_PORT" | xargs kill -9 2>/dev/null || true
  sleep 0.3
fi

# ── Device selection ──────────────────────────────────────
ATTACHED_DEVICES=$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')
if [ -n "$ATTACHED_DEVICES" ]; then
  echo "Using attached device(s):"
  echo "$ATTACHED_DEVICES" | sed 's/^/   /'
  if echo "$ATTACHED_DEVICES" | grep -qvE '^emulator-'; then
    if [ -z "${CAP_DEV_URL:-}" ] && [ "$DEV_HOST" = "10.0.2.2" ]; then
      TAILSCALE_DEV_URL="$(local_dev_url)"
      if [ -n "$TAILSCALE_DEV_URL" ]; then
        CAP_DEV_URL="$TAILSCALE_DEV_URL"
        echo ""
        echo "Physical device detected — using hatchkit Tailscale dev URL:"
        echo "  $CAP_DEV_URL"
      else
        echo ""
        echo "Physical device detected but DEV_HOST=10.0.2.2 (emulator-only)."
        echo "Re-run with your Mac's LAN IP:"
        echo "  LAN_IP=\$(ipconfig getifaddr en0) pnpm dev:android"
        echo "Or set CAP_DEV_URL to a reachable HTTPS dev URL."
        exit 1
      fi
    fi
  fi
elif adb devices | awk 'NR>1 && $2 == "unauthorized" { found=1 } END { exit !found }'; then
  echo "Phone shows 'unauthorized' in adb devices."
  echo "Tap 'Allow' on the USB debugging prompt on the phone."
  exit 1
else
  echo "No device attached — booting emulator: $AVD_NAME"
  # Headless by default: an emulator window pops to the front on every
  # boot and steals focus. ANDROID_SHOW_WINDOW=1 opts back in.
  EMU_WINDOW_FLAG="-no-window"
  EMU_GPU="swiftshader_indirect"
  if [ "${ANDROID_SHOW_WINDOW:-0}" = "1" ]; then EMU_WINDOW_FLAG=""; EMU_GPU="host"; fi
  # shellcheck disable=SC2086
  nohup emulator -avd "$AVD_NAME" \
      $EMU_WINDOW_FLAG \
      -no-boot-anim \
      -no-audio \
      -memory 2048 \
      -gpu "$EMU_GPU" \
      -netdelay none -netspeed full \
    > /tmp/starter-emulator.log 2>&1 &
  disown
  echo "   waiting for adb..."
  adb wait-for-device
  echo "   waiting for Android boot..."
  BOOT_TIMEOUT=120
  SECS=0
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 1
    SECS=$((SECS + 1))
    if [ $SECS -ge $BOOT_TIMEOUT ]; then
      echo "Emulator didn't finish booting in ${BOOT_TIMEOUT}s."
      echo "Log: /tmp/starter-emulator.log"
      exit 1
    fi
  done
  echo "Emulator ready"
fi

# ── Next.js dev server ────────────────────────────────────
CAP_DEV_URL="${CAP_DEV_URL:-http://$DEV_HOST:$NEXT_PORT}"
echo "Starting Next.js dev server at $CAP_DEV_URL"
# Next 16 blocks cross-origin requests for /_next dev resources, and the
# document here is served from the emulator's view of the host
# (http://10.0.2.2:<port>), which is cross-origin to the dev server.
# Without this the document loads, every chunk is blocked, and the app sits
# on a splash that `launchAutoHide: false` never hides. next.config.ts
# merges NEXT_DEV_ORIGINS into `allowedDevOrigins`.
CAP_DEV_ORIGIN="$(printf %s "$CAP_DEV_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
export NEXT_DEV_ORIGINS="${NEXT_DEV_ORIGINS:+$NEXT_DEV_ORIGINS,}$CAP_DEV_ORIGIN"
echo "   allowedDevOrigins: $NEXT_DEV_ORIGINS"
echo "   server must trust this origin too:"
echo "     TRUSTED_ORIGINS=$CAP_DEV_ORIGIN pnpm run dev"
(cd "$REPO/packages/client" && npx next dev --hostname 0.0.0.0 --port "$NEXT_PORT") &
NEXT_PID=$!

echo "   waiting for Next.js to answer..."
READY_TIMEOUT=60
SECS=0
until curl -s -o /dev/null "http://localhost:$NEXT_PORT"; do
  sleep 0.5
  SECS=$((SECS + 1))
  if [ $SECS -ge $((READY_TIMEOUT * 2)) ]; then
    echo "Next.js didn't start in ${READY_TIMEOUT}s."
    exit 1
  fi
done
echo "Next.js ready"

# ── Fallback bundle ───────────────────────────────────────
# cap sync needs an existing assets/public tree; build once on first run.
if [ ! -d "$REPO/android/app/src/main/assets" ] || [ ! -d "$REPO/packages/client/out-mobile" ]; then
  echo "Building fallback static export (first run)..."
  (cd "$REPO" && NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://10.0.2.2:3000}" pnpm build:mobile android)
fi

# ── Capacitor sync + deploy ───────────────────────────────
# A bare `cap sync` is correct HERE and nowhere else — see scripts/ios-dev.sh.
# Live reload is not the app: the document origin is the dev server's.
echo "Syncing Capacitor (server.url = $CAP_DEV_URL)"
export CAP_DEV_URL
(cd "$REPO" && npx cap sync android)

TARGET_SERIAL=$(adb devices | awk 'NR>1 && $2 == "device" { print $1; exit }')
if [ -z "$TARGET_SERIAL" ]; then
  echo "No device visible to adb."
  exit 1
fi

echo "Installing + launching on $TARGET_SERIAL..."
(cd "$REPO" && npx cap run android --target "$TARGET_SERIAL")

echo ""
echo "Live-reload active. Ctrl+C to stop (emulator stays running)."
wait "$NEXT_PID"
