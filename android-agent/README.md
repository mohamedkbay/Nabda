# Nabda Android Phone Agent

A deliberately small Android app: one Java `Activity`, Android SDK views, `HttpURLConnection`, and one foreground polling `Service`. There is no Compose, AppCompat, Kotlin runtime, or third-party runtime dependency.

The normal development APK is **simulation-only**. It contains no `SmsManager` reference and cannot send a carrier SMS.

## Three-step setup

1. Start the Nabda API locally and create/copy a device token from the Nabda device setup flow.
2. Connect one unlocked phone by USB, enable USB debugging, then build and install the safe APK from the project root:

   ```bash
   export ANDROID_SDK_ROOT=/Users/mohamedbay/.android-sdk
   npm run android:install:simulation
   ```

   The installer applies `adb reverse tcp:3000 tcp:3000`, installs the APK, and opens it.

3. In **Nabda Agent (Simulation)**, enter `http://127.0.0.1:3000` and the device token, then tap **Connect & start**.

   Android emulator users can instead enter `http://10.0.2.2:3000`. A production/release server must use HTTPS.

The screen then shows **Connected** and its last queue activity. A persistent low-priority notification keeps the `remoteMessaging` foreground service visible.

## What the agent calls

All requests use `Authorization: Bearer <device_token>`; the token is encrypted at rest with an AES-GCM key held by Android Keystore.

1. `POST /v1/device/heartbeat`
2. `POST /v1/device/messages/claim` — reserves at most one message
3. `POST /v1/device/messages/{id}/begin` — must explicitly authorize the stable attempt before any dispatch
4. `POST /v1/device/messages/{id}/events` — records the result with the same lease and attempt

Pending dispatch/event state is encrypted. The agent will not repeat an uncertain dispatch after a process restart. In the simulation build, a server result of `cancelled` with `simulation_only` is shown as **Simulation complete — no SMS sent**.

## Verification

```bash
export ANDROID_SDK_ROOT=/Users/mohamedbay/.android-sdk
./gradlew :app:testSimulationDebugUnitTest :app:assembleSimulationDebug
```

The debug APK is written to:

```text
app/build/outputs/apk/simulation/debug/app-simulation-debug.apk
```

The verified handoff copy is kept at:

```text
artifacts/Nabda-Agent-Simulation-0.1.0.apk
```

No app installation or SMS send is performed by the build.

## Live SMS safety gate

Live transport is excluded from normal builds. It exists only for internal sideloading and requires all three gates:

1. Explicit release build property: `-PenableLiveSms=true`
2. Explicit recipient-use confirmation inside the app
3. Android `SEND_SMS` runtime permission

Only then can this command create the unsigned live release artifact:

```bash
./gradlew :app:assembleLiveRelease -PenableLiveSms=true
```

`SEND_SMS` is a sensitive, Play-restricted permission. This MVP is for controlled internal sideloading; it is not configured for Play Store publication. Carrier charges and carrier rules still apply.

## Troubleshooting

- With the recommended USB setup, keep the API on localhost and use `http://127.0.0.1:3000` after `adb reverse`.
- If the token is rejected, provision a new device token; never place it in source code or screenshots.
- Debug accepts cleartext HTTP only through `127.0.0.0/8` or `::1` (normally with `adb reverse`), plus emulator gateway `10.0.2.2`. It rejects Wi-Fi/LAN addresses and `.local` names. Release rejects all HTTP before making a request.
- Battery optimization by some phone vendors can still pause a foreground service; allow background activity for Nabda Agent on the company phone if needed.
