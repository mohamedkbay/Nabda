# Nabda Android Phone Agent

A small Android companion for Nabda Desktop. The normal `simulation` flavor cannot send carrier SMS: it contains neither the `SEND_SMS` permission nor an `SmsManager` implementation.

The app uses Android SDK views and one foreground service. JourneyApps ZXing is included only for local QR pairing; there is no Compose or application framework.

## Pair with Nabda Desktop

1. Keep the Windows computer and Android phone on the same trusted Wi-Fi network.
2. In Nabda Desktop, open **Devices**, create a five-minute pairing session, and show its QR.
3. Open **Nabda Agent (Simulation)**, tap **Scan Desktop QR**, scan it, verify the Desktop identity and private IP shown in the confirmation, then tap **Pair**.

The QR contract is versioned and strict:

```text
nabda://pair?v=1&endpoint=http%3A%2F%2F192.168.1.20%3A47831&code=<43-character-base64url>&desktop=<short-id>
```

The 32-byte base64url code is single-use and expires on Desktop after five minutes. The app sends it once to:

```text
POST /local/v1/pairing/claim
```

with this shape:

```json
{
  "code": "<one-time-code>",
  "phone": {
    "name": "Android device name",
    "installationId": "<local-random-id>",
    "platform": "android",
    "appVersion": "0.2.0-simulation-debug"
  }
}
```

The returned scoped device token is never displayed or logged. It is encrypted with AES-GCM using a non-exportable Android Keystore key before being stored in private app preferences.

### Manual fallback

If scanning is unavailable, copy the exact private IPv4 Desktop address and the one-time secret into the two fields, then tap **Pair this phone**. Hostnames, public IPs, loopback, link-local addresses, URL credentials, extra paths, query strings, and fragments are rejected before a request is opened.

## Connection state and safe test

- **Connected** means Desktop accepted a heartbeat.
- **Offline** means Desktop is unreachable, credentials were rejected, or the agent was stopped.
- **Test phone connection (no SMS)** calls only `POST /local/v1/device/heartbeat` with `installationId` and `appVersion`. It does not claim a message, invoke the dispatcher, or access carrier SMS.

The app keeps the background connection visible through a low-priority foreground-service notification. The simulation dispatcher remains the default transport.

This first Desktop-paired release runs the foreground service in **heartbeat-only** mode. It does not poll message claim/begin/event endpoints. Message dispatch remains isolated legacy code and is not reachable from the local Desktop connection loop.

## Local HTTP security boundary

This phase uses HTTP because the Desktop endpoint is local and certificate installation is intentionally deferred. `ServerUrlPolicy` accepts only literal RFC 1918 IPv4 addresses (`10/8`, `172.16/12`, `192.168/16`) with an explicit port. Android network-security XML cannot express those CIDRs, so cleartext is enabled at the manifest layer and the Java policy is the mandatory pre-I/O enforcement point.

The pairing secret protects only the short pairing window; HTTP does not provide confidentiality against an attacker already able to observe the same LAN. Pair only on a trusted network, verify the Desktop identity/address in the confirmation, and rotate/revoke a device from Desktop if the network or phone may be compromised. A future release should add authenticated local TLS.

## Build and test

From `android-agent`:

```bash
export ANDROID_SDK_ROOT=/Users/mohamedbay/.android-sdk
./gradlew :app:testSimulationDebugUnitTest :app:assembleSimulationDebug
```

The APK is written to:

```text
app/build/outputs/apk/simulation/debug/app-simulation-debug.apk
```

The verified handoff copy is:

```text
artifacts/Nabda-Agent-Simulation-0.2.0.apk
```

The tests cover strict QR parsing, private-LAN URL enforcement, the exact pairing request, and the connectivity-only heartbeat body.

No app installation and no SMS send occurs during build or unit tests.

## Live SMS safety gate

Live transport remains excluded from normal builds. It is available only as an explicit internal release build and still requires all three gates:

1. `-PenableLiveSms=true`
2. expected-transactional-use confirmation in the app
3. Android `SEND_SMS` runtime permission

```bash
./gradlew :app:assembleLiveRelease -PenableLiveSms=true
```

The `simulation` source set has no carrier permission or `SmsManager` reference. Do not enable the live flavor during development or connection testing.

## Troubleshooting

- Confirm both devices are on the same Wi-Fi and that Windows Firewall permits Nabda Desktop on the private network.
- Generate a new pairing session if the code is older than five minutes or was already used.
- Do not paste the pairing code or device token into logs, screenshots, support messages, or source code.
- If a paired token is rejected, revoke the device in Desktop and pair again.
- Some Android vendors pause background work aggressively; allow background activity for Nabda Agent if the foreground connection is interrupted.
