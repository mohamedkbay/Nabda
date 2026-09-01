#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
apk_path="$project_root/android-agent/artifacts/Nabda-Agent-LAN-0.1.0-debug.apk"
checksum_path="$apk_path.sha256"
android_sdk_path=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}

if [ -n "$android_sdk_path" ] && [ -x "$android_sdk_path/platform-tools/adb" ]; then
  adb_tool="$android_sdk_path/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
  adb_tool=$(command -v adb)
  android_sdk_path=$(CDPATH= cd -- "$(dirname -- "$adb_tool")/.." && pwd)
else
  echo "Android platform-tools were not found. Set ANDROID_SDK_ROOT first." >&2
  exit 1
fi

if [ ! -f "$apk_path" ] || [ ! -f "$checksum_path" ]; then
  echo "The verified LAN APK is missing. Run npm run android:build:lan first." >&2
  exit 1
fi

(
  cd "$(dirname -- "$apk_path")"
  shasum -a 256 -c "$(basename -- "$checksum_path")"
)

aapt_tool=$(find "$android_sdk_path/build-tools" -type f -name aapt -perm -111 2>/dev/null | sort | tail -n 1)
if [ -z "$aapt_tool" ] || ! "$aapt_tool" dump permissions "$apk_path" | grep -Fq "android.permission.SEND_SMS"; then
  echo "Safety check failed: this is not the explicitly built LAN SMS APK." >&2
  exit 1
fi

connected_devices=$($adb_tool devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }')
if [ "$connected_devices" -ne 1 ]; then
  echo "Connect exactly one unlocked Android phone and accept USB debugging." >&2
  "$adb_tool" devices -l >&2
  exit 1
fi

"$adb_tool" install -r "$apk_path"
"$adb_tool" shell am start -n com.nabda.agent.debug/com.nabda.agent.MainActivity

echo
echo "Nabda Agent opened. Enter the computer's private Wi-Fi URL and the one-time device token."
