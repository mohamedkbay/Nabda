# Nabda Android Agent

A small native Android gateway built with Java, SDK views, `HttpURLConnection`, Android Keystore, Google Code Scanner, and one foreground service. It has no Flutter, React Native, Compose, Retrofit, or local database dependency. QR scanning is delegated to Google Play services and does not require camera permission in the app.

## Two builds

- `simulationDebug`: no `SEND_SMS` permission and no carrier transport.
- `liveDebug`: internal same-LAN build; includes `SEND_SMS` only after the explicit Gradle flag and still requires in-app confirmation plus Android permission.

Build both:

```bash
export ANDROID_SDK_ROOT=/Users/mohamedbay/.android-sdk
npm run android:build:simulation
npm run android:build:lan
```

Verified artifacts:

```text
artifacts/Nabda-Agent-Simulation-0.1.0.apk
artifacts/Nabda-Agent-LAN-0.1.0-debug.apk
```

## Windows Controller setup (recommended)

1. Start Nabda Controller on Windows and open **Device**.
2. Click **Create pairing QR**. The code expires after two minutes and works once.
3. On Android, tap **Scan controller QR** and scan the screen.
4. Tap **Start connection**. The device token is returned by the one-time exchange and encrypted with Android Keystore; it is never typed or copied.
5. For the live build, confirm expected-message use and grant the SMS permission. The Windows carrier lock must also be enabled.

Both devices must remain on the same trusted Wi-Fi. The debug URL policy accepts HTTP only for loopback, the emulator gateway, and RFC1918 private addresses. Release builds require HTTPS.

## API server setup (advanced)

1. Start Nabda with `docker-compose.live.yml`.
2. Provision a live device token using `npm run db:device-agent` through the same Compose files.
3. Connect exactly one unlocked phone over USB and run `npm run android:install:lan`.
4. Enter `http://<computer-private-ip>:3000` and the one-time device token.
5. Confirm expected-message use, tap **Connect & start**, and grant the SMS permission.

The multi-tenant API server currently keeps its administrative token-provisioning flow for server deployments. The QR flow is the preferred zero-copy setup for the local Windows Controller.

## Pull protocol

The foreground service performs:

1. `POST /v1/device/heartbeat`
2. `POST /v1/device/messages/claim`
3. `POST /v1/device/messages/{id}/begin`
4. Android SMS dispatch
5. `POST /v1/device/messages/{id}/events`

It claims one item at a time. Leases and attempt IDs prevent concurrent or duplicate work. Encrypted pending state survives process interruption; if the app restarts during an uncertain carrier operation, Nabda marks it for manual review and does not retry blindly.

## Security

- The device bearer token is encrypted using an AES-GCM key held by Android Keystore.
- Redirects are disabled so a token cannot be forwarded to another host.
- Responses are size-limited and network operations have timeouts.
- Real SMS requires the live build flag, user confirmation, and runtime permission.
- The service reconnects after Wi-Fi loss and continues without downloading the campaign in bulk.
