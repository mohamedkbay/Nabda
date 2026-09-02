# Nabda API

Nabda is a self-hosted, multi-tenant messaging API. A company connects its own Android phone and SIM, queues expected service messages through an API, and lets the phone send them while it is connected to the same trusted Wi-Fi network.

The platform is free and the local plan accepts up to **5,000 message operations per month**. SIM credit, carrier fees, phones, and infrastructure remain the operator's responsibility.

## What is included

- TypeScript and Fastify API
- PostgreSQL as the durable source of truth
- Redis and BullMQ for background jobs and rate limits
- Native lightweight Android agent written in Java
- API keys and device tokens stored as keyed hashes
- Organization-level tenant isolation
- Idempotent message creation
- Contacts, consent references, opt-outs, and duplicate protection
- Queue recovery, message expiry, retention cleanup, audit logs, and signed webhooks
- Mock and Android provider boundaries
- English product site, Help Center, OpenAPI file, and Postman collection
- One-click Windows background controller with a browser dashboard and local SQLite storage

## Easiest option: Windows Controller

For a single Windows computer and one Android phone, install **Nabda Controller**. It runs in the system tray, stores the queue in a local SQLite database, and opens its controls in Chrome, Edge, or your default browser. It does not require Docker, PostgreSQL, or Redis.

1. Install `Nabda-Controller-0.1.0-Setup-x64.exe`.
2. Open Nabda from the Start menu. The browser dashboard opens at `http://127.0.0.1:3210`; you can also enter that address directly on the same computer.
3. In **Device**, create a two-minute pairing QR. In Nabda Agent on Android, tap **Scan controller QR**. The code works once and never contains the permanent device key.
4. Tap **Start connection** on Android. On a Dual-SIM phone, choose the exact sending SIM shown as `SIM 1 — carrier` or `SIM 2 — carrier`. For live SMS, type `ENABLE_LIVE_SMS` in Windows and complete the separate Android confirmation.
5. Add one contact or import CSV, TXT, or VCF. The importer supports `Name,Emails,PhoneNumbers` and expands semicolon-separated numbers into separate contacts.
6. Queue one message or create a controlled contact campaign in the browser.

Closing the browser does not stop Nabda. The controller and queue continue in the Windows background. Click the tray icon to reopen the dashboard, enable **Start with Windows** if wanted, or use **Lock carrier sending** for an immediate stop.

The Windows dashboard is restricted to the same computer. Only `/health`, the one-time pairing exchange, and the authenticated `/v1/device/*` phone protocol are reachable from the private LAN. Pairing expires after two minutes and is consumed atomically. Device tokens and message leases are stored only as SHA-256 hashes.

Build the unsigned internal Windows installer locally with:

```bash
npm ci
npm run dist:win
```

The installer is written to `release/`. Windows may display an unknown-publisher warning until a code-signing certificate is configured.

## Architecture

```text
Your application
      │  API on the trusted LAN
      ▼
Nabda API ───── PostgreSQL
      │              │
      └── Redis ─────┴── queue, limits, events and audit

Android phone on the same Wi-Fi
      │ heartbeat → claim one → begin → report result
      └───────────────────────────────────────────────┘
```

The phone never downloads the whole campaign. It claims one message, asks the server for final send authorization, sends it through Android, reports the result, and immediately requests the next item. If Wi-Fi disappears, the phone waits and resumes automatically.

## Current local limits

| Limit | Value |
| --- | ---: |
| Monthly accepted messages | 5,000 |
| Dispatch rate | 10 messages/minute |
| Active contacts | 10,000 |
| Android devices | 1 per organization |
| API keys | 3 per organization |
| Webhooks | 2 per organization |
| Sensitive-data retention | 30 days |

At 10 messages per minute, 4,000 messages take about 6 hours 40 minutes and 5,000 take about 8 hours 20 minutes. The rate protects the phone, SIM, and queue. Change it only after confirming the permitted carrier rate.

## Docker/API deployment requirements

- Docker Desktop with Docker Compose
- Android 8 or newer for the phone agent
- Node.js 22+ only when developing outside Docker
- Java 17 and Android SDK only when rebuilding the APK

## 1. Configure the local server

Copy the example file and add three unique local secrets:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
openssl rand -base64 48
openssl rand -base64 32
```

Put the results in `.env` as `POSTGRES_PASSWORD`, `API_KEY_HASH_SECRET`, and `APP_ENCRYPTION_KEY`. The encryption key must decode to exactly 32 bytes. Never commit `.env`.

Start the safe simulation stack:

```bash
docker compose up --build -d
```

Start the same-LAN live stack only when ready to connect the company phone:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml up --build -d
```

The API listens on port `3000`. PostgreSQL and Redis remain bound to the computer only.

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/health/ready
```

## 2. Create the API key and phone token

In simulation mode:

```bash
docker compose run --rm migrate npm run db:free
docker compose run --rm migrate npm run db:device-agent
```

In live LAN mode:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml run --rm migrate npm run db:free
docker compose -f docker-compose.yml -f docker-compose.live.yml run --rm migrate npm run db:device-agent
```

Each command prints its raw credential once. Copy it immediately:

- Put the `nbda_live_...` API key only in the application that calls Nabda.
- Put the `nbda_device_...` token only in the Android agent.
- Never place either credential in source code, URLs, screenshots, or logs.

Running either command again rotates the matching local credential.

## 3. Install and connect the phone

The verified same-LAN debug APK is:

```text
android-agent/artifacts/Nabda-Agent-LAN-0.1.0-debug.apk
```

Install it over USB:

```bash
export ANDROID_SDK_ROOT=/Users/mohamedbay/.android-sdk
npm run android:install:lan
```

Keep the phone and computer on the same trusted private Wi-Fi. In the app enter:

```text
Server URL: http://<computer-private-ip>:3000
Device token: <nbda_device_... token>
```

For example, a private address may look like `http://192.168.1.20:3000` or `http://10.0.0.20:3000`.

Then:

1. Check the expected-message confirmation.
2. Tap **Connect & start**.
3. Approve the Android SMS permission.
4. Allow background activity/battery exemption if the phone vendor pauses foreground services.

The LAN debug build accepts cleartext HTTP only for loopback and RFC1918 private addresses. Use a trusted WPA2/WPA3 network. A public deployment must use HTTPS.

## 4. Send through the API

```bash
curl --request POST http://127.0.0.1:3000/v1/messages \
  --header 'Authorization: Bearer <NBDA_API_KEY>' \
  --header 'Idempotency-Key: <unique-16-to-128-character-value>' \
  --header 'Content-Type: application/json' \
  --data '{
    "to": "+2189XXXXXXXX",
    "content": "Your order is ready.",
    "purpose": "service",
    "consent_confirmed": true,
    "consent_reference": "order-123-notification",
    "metadata": {"order_id": "123"}
  }'
```

The server chooses the active Android device automatically. `device_id` is optional for a one-phone organization.

```bash
curl http://127.0.0.1:3000/v1/messages/<MESSAGE_ID> \
  --header 'Authorization: Bearer <NBDA_API_KEY>'

curl http://127.0.0.1:3000/v1/usage \
  --header 'Authorization: Bearer <NBDA_API_KEY>'
```

Message states are `queued`, `sent`, `delivered`, `failed`, `expired`, and `cancelled`.

## API rules

- `Idempotency-Key` is mandatory for every create request.
- Numbers use E.164 format.
- `purpose` is `transactional`, `authentication`, or `service`.
- Every request stores a traceable `consent_reference`.
- The MVP accepts one SMS segment: 160 GSM-7 units or 70 UTF-16 units.
- An active opt-out is checked when the request enters the queue and immediately before phone authorization.
- The system never retries an uncertain carrier operation after an app/process restart.

Core routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health/ready` | PostgreSQL and Redis readiness |
| `POST` | `/v1/messages` | Queue an idempotent message |
| `GET` | `/v1/messages/:id` | Read a tenant-scoped message |
| `GET` | `/v1/usage` | Read current limits and usage |
| `GET` | `/v1/queue` | Read queue state |
| `POST` | `/v1/contacts` | Create or update a contact |
| `GET` | `/v1/contacts` | List contacts |
| `DELETE` | `/v1/contacts/:id` | Delete a contact |
| `POST` | `/v1/opt-outs` | Block a number and cancel queued messages |

Documentation is available at `/help`, `/openapi.yaml`, and `/downloads/nabda-api.postman_collection.json`.

## Testing

The normal checks do not send SMS:

```bash
npm run check
npm test
npm run build
npm run android:build:simulation
npm run android:build:lan
docker compose config --quiet
```

`android:smoke:simulation` exercises the full lease protocol in simulation. `android:smoke:lan-live` verifies live credentials, heartbeat, queue, and claim, then cancels the message before `/begin`; it never authorizes an SMS.

## Security notes

- API keys and device tokens are stored as keyed HMAC digests.
- The Android token and pending attempt state are encrypted with Android Keystore.
- The selected Android subscription is encrypted too. Every live dispatch verifies that it is still active and never falls back silently to another SIM.
- Tenant identity always comes from the authenticated credential.
- Phone claims are limited to one message and use short, hashed leases.
- Opt-out and dispatch share database locks to close race conditions.
- Worker and Android dispatch paths are separated so a worker cannot steal a phone message.
- Authorization headers, message content, and credentials are redacted from logs.
- Webhooks use HMAC signatures and bounded retries.
- PostgreSQL and Redis are not exposed to the Wi-Fi network.

## Project layout

```text
src/             API, domain services, repositories, queue and workers
migrations/      Ordered PostgreSQL migrations
android-agent/   Native Android simulation and same-LAN variants
tests/           API, security, queue and device protocol tests
public/          Marketing site and Help Center
docs/            OpenAPI, Postman and architecture decisions
desktop/         Windows tray controller, browser dashboard and SQLite store
```

## Responsible operation

Use Nabda only for expected service, authentication, and transaction messages. The operator is responsible for the SIM, carrier agreement, recipient records, message content, opt-outs, staff access, and applicable law. Unsolicited advertising, impersonation, fraud, unauthorized interception, and bypassing the safety controls are prohibited.

See `/legal` for the project notice. This repository is not legal advice.
