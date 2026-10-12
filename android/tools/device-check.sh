#!/usr/bin/env bash
#
# Everything worth knowing about a phone running Spot Picker, in one run.
#
# The app can only report on itself. This asks the *system* the same questions —
# whether the mock app-op is really granted, which providers exist, whether the
# foreground service survived, and whether a consumer app like WhatsApp is even
# allowed to run in the background while it waits for a live fix. Those are the
# answers a phone cannot give you by itself.
#
# Usage:  bash spot-picker/android/tools/device-check.sh [package-of-the-app-under-test]
#         bash spot-picker/android/tools/device-check.sh com.whatsapp

set -uo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/e/toolchain/androidsdk}}"
ADB="$SDK/platform-tools/adb.exe"
[ -x "$ADB" ] || ADB="$SDK/platform-tools/adb"
APP=com.spotpicker.app
TARGET="${1:-com.whatsapp}"

say() { printf '\n=== %s ===\n' "$1"; }
run() { printf '\n$ %s\n' "$*"; "$@" 2>&1 | sed 's/\r$//'; }

if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "No device. Enable USB debugging (Developer options) or pair wireless debugging, then retry."
  "$ADB" devices -l 2>&1
  exit 1
fi

say "Device"
run "$ADB" shell getprop ro.product.manufacturer
run "$ADB" shell getprop ro.product.model
run "$ADB" shell getprop ro.build.version.release
run "$ADB" shell getprop ro.build.version.sdk
run "$ADB" shell getprop ro.build.version.security_patch

say "Spot Picker installed?"
run "$ADB" shell pm list packages "$APP"
run "$ADB" shell dumpsys package "$APP" | grep -E "versionName|versionCode|firstInstallTime|lastUpdateTime" | head -5

say "The three setup conditions, as the system sees them"
echo "-- developer options unlocked (1 = yes)"
run "$ADB" shell settings get global development_settings_enabled
echo "-- mock-location app-op (allowed = the app is the selected mock app)"
run "$ADB" shell cmd appops get "$APP" android:mock_location
echo "-- granted runtime permissions"
run "$ADB" shell dumpsys package "$APP" | grep -E "ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION" | head -6

say "Providers the system currently has"
# A mocked provider shows up twice: once as the test provider, once as the real one.
run "$ADB" shell dumpsys location | grep -iE "provider|mock" | head -40

say "Is Spot Picker's service alive?"
run "$ADB" shell dumpsys activity services "$APP"
echo "-- notification, which the service must post to stay in the foreground"
run "$ADB" shell dumpsys notification --noredact | grep -iE "spotpicker|mock location|route" | head -12

say "What the app itself thinks (its own diagnostics)"
echo "Open Spot Picker > Setup > Troubleshooting > Copy report and paste it here;"
echo "it carries the installed provider list and the last system error verbatim."

say "$TARGET: can it receive a live location at all?"
echo "-- location permissions (a live share needs FINE or BACKGROUND)"
run "$ADB" shell dumpsys package "$TARGET" | grep -E "ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION" | head -6
echo "-- is it restricted in the background?"
run "$ADB" shell cmd appops get "$TARGET" RUN_ANY_IN_BACKGROUND
run "$ADB" shell cmd appops get "$TARGET" RUN_IN_BACKGROUND
echo "-- battery optimisation / doze (whitelist = unrestricted)"
run "$ADB" shell dumpsys deviceidle whitelist | grep -i "$TARGET"
run "$ADB" shell am get-standby-bucket "$TARGET"

say "$TARGET: can it send anything at all?"
echo "-- data saver must not be restricting it, or a queued message never leaves"
run "$ADB" shell cmd netpolicy get restrict-background
echo "-- is it in the foreground right now?"
run "$ADB" shell dumpsys activity activities | grep -iE "topResumedActivity|mResumedActivity" | head -4

say "Network from the phone's point of view"
run "$ADB" shell ping -c 3 -W 2 8.8.8.8
run "$ADB" shell ping -c 3 -W 2 g.whatsapp.net

say "Live location: the last thing the system served, per provider"
run "$ADB" shell dumpsys location --short

echo
echo "Done. For a live trace while you reproduce the failure in $TARGET:"
echo "  $ADB logcat -c && $ADB logcat | grep -iE 'spotpicker|location|mock|whatsapp'"
