#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_directory="$project_root/android-agent/artifacts"
apk_path="$artifact_directory/Nabda-Agent-Simulation-0.1.0.apk"
checksum_path="$artifact_directory/Nabda-Agent-Simulation-0.1.0.apk.sha256"

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
  echo "The verified Simulation APK or its checksum file is missing. Run npm run android:build:simulation." >&2
  exit 1
fi

(
  cd "$artifact_directory"
  shasum -a 256 -c "$(basename "$checksum_path")"
)

aapt_tool=$(find "$android_sdk_path/build-tools" -type f -name aapt -perm -111 2>/dev/null | sort | tail -n 1)
if [ -z "$aapt_tool" ]; then
  echo "Android aapt was not found; install Android build-tools before installing the APK." >&2
  exit 1
fi
if "$aapt_tool" dump permissions "$apk_path" | grep -Fq "android.permission.SEND_SMS"; then
  echo "Safety check failed: the Simulation APK unexpectedly requests SEND_SMS." >&2
  exit 1
fi

connected_devices=$("$adb_tool" devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }')
if [ "$connected_devices" -ne 1 ]; then
  echo "Connect exactly one unlocked Android phone with USB debugging enabled, then accept its USB authorization prompt." >&2
  "$adb_tool" devices -l >&2
  exit 1
fi

# Keep Docker bound to localhost. USB reverse makes the phone's localhost:3000
# reach the Mac without exposing the API to the Wi-Fi network.
"$adb_tool" reverse tcp:3000 tcp:3000
"$adb_tool" install -r "$apk_path"
"$adb_tool" shell am start \
  -n com.nabda.agent.simulation.debug/com.nabda.agent.MainActivity

echo
echo "Nabda Agent opened. Use server URL http://127.0.0.1:3000 and paste the one-time Device token."
echo "This APK is simulation-only and has no SEND_SMS permission."
