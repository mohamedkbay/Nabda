# Nabda API SaaS

Nabda is a multi-tenant messaging API for expected transactional messages. An organization connects its own Android phone and SIM, creates scoped API keys, and sends messages through a queue with usage limits, opt-outs, idempotency, audit logs, and signed webhooks.

The platform is free to use within explicit fair-use limits. It does not promise unlimited SMS, and mobile-carrier charges are not included.

> [!IMPORTANT]
> Nabda currently runs in **Mock/Simulation mode by default**. The documented local setup cannot send carrier SMS. Live delivery requires a separate security, legal, carrier, and operational review.

## What is included

- TypeScript and Fastify API
- PostgreSQL as the durable source of truth
- Redis and BullMQ for rate limiting and background jobs
- Organization-level tenant isolation
- API keys stored as keyed HMAC digests, never as plaintext
- Idempotent message creation with `Idempotency-Key`
- Subscription quota and per-minute limits
- Contacts, consent references, and organization-scoped opt-outs
- Message queue, worker, outbox recovery, and status reconciliation
- Signed HMAC webhooks with retries and endpoint circuit breaking
- Mock provider enabled by default
- External provider adapter isolated behind explicit live-send gates
- Lightweight native Android agent with a safe Simulation build
- Automatic redaction of old sensitive message data
- English-first marketing site, API reference, and searchable Help Center

## Architecture

```text
API client
    │
    ▼
Fastify API ─────► PostgreSQL
    │                 │
    │                 └── tenants, keys, messages, usage,
    │                     contacts, opt-outs, events, audit
    ▼
Redis / BullMQ
    │
    ▼
Worker ──────────► Mock provider (default)
    │
    ├────────────► external provider adapter (live-gated)
    ├────────────► signed webhooks
    └────────────► retention and reconciliation jobs

Android agent ◄──── short leases and device-scoped credentials
```

Message states:

| State | Meaning |
| --- | --- |
| `queued` | Accepted and waiting for dispatch |
| `sent` | Accepted by the phone or provider |
| `delivered` | Delivery was confirmed |
| `failed` | Permanently failed or unsafe to retry |
| `expired` | Expired before completion |
| `cancelled` | Cancelled before dispatch, including opt-out cancellation |

## Requirements

- Docker with Docker Compose, or Node.js 22+ and local PostgreSQL/Redis
- Node.js 24 LTS is recommended for direct local development
- No external SMS-provider key is required for development

Default local ports:

| Service | Address |
| --- | --- |
| Website and API | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:5432` |
| Redis | `127.0.0.1:6379` |

## Quick start with Docker

Clone the project and enter its directory:

```bash
git clone git@github.com:mohamedkbay/nabda.git
cd nabda
```

Create the local environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Generate three different development secrets:

```bash
openssl rand -hex 24
openssl rand -base64 48
openssl rand -base64 32
```

Place the generated values in `.env`:

```dotenv
POSTGRES_PASSWORD=<hex-output>
API_KEY_HASH_SECRET=<base64-48-output>
APP_ENCRYPTION_KEY=<base64-32-output>
```

`APP_ENCRYPTION_KEY` must decode to exactly 32 bytes. Never commit `.env`, and never reuse production secrets in development.

Start the complete local stack:

```bash
docker compose up --build -d
```

Compose waits for PostgreSQL and Redis, applies all migrations, then starts the API and worker. The development configuration forces:

```dotenv
PROVIDER_MODE=mock
ENABLE_LIVE_SMS=false
ENABLE_ANDROID_AGENT_LIVE_REPORTING=false
```

Create or rotate a local organization and API key on the permanent Free plan:

```bash
docker compose run --rm migrate npm run db:free
```

Copy the displayed API key immediately. The raw value is shown once; only its non-reversible digest is stored.

Check the stack:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/health/ready
docker compose ps
```

Expected health output:

```json
{"status":"ok","provider_mode":"mock"}
{"status":"ready"}
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) for the product site.

## Free plan

The local Free plan has no expiration date and currently includes:

- 1,000 accepted message operations per month
- 10 accepted operations per minute
- 1 Android device
- 3 API keys
- 2 webhooks
- 500 active contacts
- 30-day sensitive-data retention window

An idempotent replay does not consume another operation. Rejected requests do not consume usage. Later cancellation does not restore an accepted operation.

Platform access is free; SIM credit, carrier fees, data service, phones, and infrastructure are the operator's responsibility.

## Send a Mock message

API keys use the `Authorization` header and must never appear in a URL or log:

```http
Authorization: Bearer <NBDA_API_KEY>
```

Create a message:

```bash
curl --request POST http://127.0.0.1:3000/v1/messages \
  --header 'Authorization: Bearer <NBDA_API_KEY>' \
  --header 'Idempotency-Key: 018f47c4-6ec8-7d8a-a14f-13ab5d4e2132' \
  --header 'Content-Type: application/json' \
  --data '{
    "to": "+2189XXXXXXXX",
    "content": "Your verification code is 123456",
    "purpose": "authentication",
    "consent_confirmed": true,
    "consent_reference": "consent-record-demo-1",
    "metadata": {"order_id": "demo-1"}
  }'
```

Requirements:

- `Idempotency-Key` is mandatory.
- Phone numbers must use E.164 format.
- `consent_reference` must identify an auditable record in the operator's system.
- The sender number is derived from the selected organization device; clients cannot provide it.
- The MVP accepts one SMS segment: up to 160 GSM-7 units or 70 UTF-16 units.
- Use fictional phone numbers in development. Mock mode does not send anything.

Repeating the same idempotency key and payload returns the original message without charging usage again. Reusing the key with a different payload returns `409`.

Read the message and current usage:

```bash
curl http://127.0.0.1:3000/v1/messages/<MESSAGE_ID> \
  --header 'Authorization: Bearer <NBDA_API_KEY>'

curl http://127.0.0.1:3000/v1/usage \
  --header 'Authorization: Bearer <NBDA_API_KEY>'
```

## Core API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and provider mode |
| `GET` | `/health/ready` | PostgreSQL and Redis readiness |
| `POST` | `/v1/messages` | Accept an idempotent message |
| `GET` | `/v1/messages/:id` | Read a tenant-scoped message |
| `GET` | `/v1/usage` | Read plan limits and current usage |
| `GET` | `/v1/queue` | Read queue counts and oldest wait time |
| `POST` | `/v1/contacts` | Create or atomically update a contact |
| `GET` | `/v1/contacts` | List contacts using cursor pagination |
| `DELETE` | `/v1/contacts/:id` | Remove contact data and retain the audit fact |
| `POST` | `/v1/opt-outs` | Block a recipient and cancel queued messages |

The full contract is available in:

- [OpenAPI specification](docs/openapi.yaml)
- [Postman collection](docs/postman/nabda-api.postman_collection.json)
- [Postman local environment](docs/postman/nabda-local.postman_environment.json)
- Local searchable Help Center at [`/help`](http://127.0.0.1:3000/help)

The Postman environment contains no API key. Add your local key to its `api_key` variable after importing it.

## Contacts and opt-outs

A contact does not grant permission for every future message. Each send request must still declare the expected communication context and include a traceable `consent_reference`.

Add or update a contact:

```bash
curl --request POST http://127.0.0.1:3000/v1/contacts \
  --header 'Authorization: Bearer <NBDA_API_KEY>' \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "Demo Customer",
    "phone": "+2189XXXXXXXX",
    "consent_reference": "crm-consent-demo-1",
    "tags": ["customer"],
    "metadata": {"crm_id": "demo-1"}
  }'
```

Add a recipient to the organization blocklist:

```bash
curl --request POST http://127.0.0.1:3000/v1/opt-outs \
  --header 'Authorization: Bearer <NBDA_API_KEY>' \
  --header 'Content-Type: application/json' \
  --data '{"phone":"+2189XXXXXXXX","reason":"Recipient requested stop"}'
```

An active opt-out is checked when a request is accepted and again at the dispatch boundary. Queued messages for that recipient are cancelled.

## Android Simulation agent

The Android client lives in [`android-agent/`](android-agent/) and uses Java with the native Android SDK. It does not require Flutter, React Native, Compose, Retrofit, or Room.

The distributed Simulation APK:

- does not request `SEND_SMS`
- contains no `SmsManager` call
- tests pairing, leases, queue claiming, state transitions, and reporting
- cannot consume SIM credit or send a carrier message

Create or rotate a device-scoped token:

```bash
docker compose run --rm migrate npm run db:device-agent
```

Do not store an organization API key on the phone. Use only the one-time device token produced by this command.

With one unlocked Android phone connected through USB and USB debugging enabled:

```bash
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
npm run android:install:simulation
```

The installer creates an `adb reverse` tunnel, installs the Simulation APK, and opens it. Enter:

```text
Server URL: http://127.0.0.1:3000
Device token: <one-time-device-token>
```

Then select **Connect & start**. The API remains bound to loopback and is not exposed to the local Wi-Fi network.

More details are in [android-agent/README.md](android-agent/README.md).

## Webhooks

Webhook bodies are signed over the exact raw bytes:

```text
HMAC_SHA256(secret, timestamp + "." + rawBody)
```

Headers:

```text
X-Nabda-Delivery-Id: <delivery-id>
X-Nabda-Event-Id: <event-id>
X-Nabda-Timestamp: <unix-seconds>
X-Nabda-Signature: v1=<hex-digest>
```

Consumers must verify the signature before parsing the body, reject stale timestamps, and deduplicate by event ID. Delivery is at least once, so handlers must be idempotent.

An endpoint is disabled after repeated failures to prevent one broken destination from occupying the shared webhook workers indefinitely.

## Security model

- Tenant identity always comes from the authenticated API key, never from request input.
- Tenant-owned queries are scoped by `organization_id` and protected by composite database relationships.
- Raw API keys and device tokens are shown once and stored as keyed digests.
- Provider credentials and webhook secrets are encrypted with AES-256-GCM.
- Message quota is durable in PostgreSQL; rate limiting is atomic in Redis and fails closed by default.
- Requests have IP, API-key, device, organization-write, and message-recipient limits.
- Opt-outs are checked both at acceptance and immediately before dispatch.
- Unknown provider outcomes enter manual review and are never retried blindly.
- Logs redact authorization headers, credentials, phone numbers, and message content.
- Webhook destinations are DNS-pinned and checked against private, loopback, link-local, translation, and rebinding targets.
- Message creation, quota accounting, events, and the outbox are committed atomically.
- Android credentials and messages are bound to either `simulation` or `live`; the client cannot switch modes.

Run security and correctness checks:

```bash
npm run check
npm test
npm run build
npm audit --omit=dev
docker compose config --quiet
```

## Retention

The worker periodically redacts terminal messages after the plan's retention period. It removes message content, recipient and sender numbers, provider references, metadata, consent references, and failure details. Related event and webhook payloads are also redacted while status, timing, usage counters, and audit facts remain available.

Expired queued messages are moved to `expired` even when an Android device is offline. Opt-out records are intentionally retained to prevent future contact.

Development defaults:

```dotenv
CLEANUP_INTERVAL_MS=3600000
CLEANUP_BATCH_SIZE=500
```

## Direct local development

Run PostgreSQL and Redis, then configure `.env` with local addresses and Mock mode:

```dotenv
DATABASE_URL=postgresql://nabda:<password>@127.0.0.1:5432/nabda
REDIS_URL=redis://127.0.0.1:6379
PROVIDER_MODE=mock
ENABLE_LIVE_SMS=false
```

Start the API:

```bash
npm install
npm run db:migrate
npm run db:free
npm run dev
```

Start the worker in another terminal:

```bash
npm run worker:dev
```

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Type-check without emitting files |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Compile production JavaScript into `dist/` |
| `npm run db:migrate` | Apply pending PostgreSQL migrations |
| `npm run db:free` | Provision or rotate the permanent local Free environment |
| `npm run db:seed` | Add broader development fixtures |
| `npm run db:device-agent` | Provision or rotate an Android device token |
| `npm run android:build:simulation` | Test, lint, and build the Simulation APK |
| `npm run android:install:simulation` | Install the Simulation APK over USB |
| `npm run android:smoke:simulation` | Exercise the Android pull protocol in Simulation mode |
| `npm run smoke` | Exercise the HTTP API in Mock mode |

The HTTP smoke test requires a local key:

```bash
NBDA_E2E_API_KEY='<local-api-key>' npm run smoke
```

It rejects non-loopback base URLs before sending credentials.

Stop the local stack while preserving data:

```bash
docker compose down
```

`docker compose down --volumes` permanently removes the local PostgreSQL and Redis volumes. Use it only when you intentionally want a clean database.

## Production status

The Mock/Simulation system is ready for local evaluation. **Live SMS is not production-approved yet.** Before live or public operation, complete at least the following:

- a recipient-facing inbound/STOP channel independent of organization staff
- explicit SIM selection and verification for dual-SIM phones
- a release APK signed with an owned production key
- separate least-privilege database roles for migrations, API, and workers
- private production PostgreSQL and Redis with authentication and backup recovery tests
- an edge WAF, trusted-proxy configuration, and external rate limiting
- monitoring, alerting, incident response, and queue recovery procedures
- carrier, regulatory, privacy, and legal review for the intended deployment

Live flags are safety gates, not substitutes for this review.

## Legal and responsible use

Nabda is a personal educational project created to develop skills in programming, system design, API security, user experience, testing, and software maintenance.

The operator of each installation is responsible for its API keys, devices, SIMs, recipients, message content, consent evidence, opt-out handling, carrier charges, infrastructure, staff access, and compliance. Spam, unsolicited promotion, impersonation, fraud, unauthorized access or interception, and bypassing safety controls are prohibited.

See the complete bilingual notice at [`/legal`](http://127.0.0.1:3000/legal). Its Libyan-law reference checklist includes:

- [Law No. 5 of 2022 on Cybercrime](https://lawsociety.ly/legislation/%D9%82%D8%A7%D9%86%D9%88%D9%86-%D8%B1%D9%82%D9%85-5-%D9%84%D8%B3%D9%86%D8%A9-2022-%D9%85-%D8%A8%D8%B4%D8%A3%D9%86-%D9%85%D9%83%D8%A7%D9%81%D8%AD%D8%A9-%D8%A7%D9%84%D8%AC%D8%B1%D8%A7%D8%A6%D9%85-%D8%A7/)
- [Law No. 6 of 2022 on Electronic Transactions](https://lawsociety.ly/legislation/%D9%82%D8%A7%D9%86%D9%88%D9%86-%D8%B1%D9%82%D9%85-6-%D9%84%D8%B3%D9%86%D8%A9-2022-%D9%85-%D8%A8%D8%B4%D8%A3%D9%86-%D8%A7%D9%84%D9%85%D8%B9%D8%A7%D9%85%D9%84%D8%A7%D8%AA-%D8%A7%D9%84%D8%A5%D9%84%D9%83/)
- [Law No. 22 of 2010 on Telecommunications](https://security-legislation.ly/ar/latest-laws/%D9%82%D8%A7%D9%86%D9%88%D9%86-%D8%B1%D9%82%D9%85-22-%D9%84%D8%B3%D9%86%D8%A9-2010-%D8%A8%D8%B4%D8%A3%D9%86-%D8%A7%D9%84%D8%A7%D8%AA%D8%B5%D8%A7%D9%84%D8%A7%D8%AA/)

The notice limits responsibility only to the extent permitted by applicable law. It cannot exclude duties or liability that mandatory law does not allow a person to exclude. This repository is not legal advice; consult a qualified Libyan lawyer, regulators, and the carrier before public or live use.

## Project structure

```text
src/
  db/             PostgreSQL connection, migrations, and provisioning
  domain/         Message states, shared types, and errors
  maintenance/    Retention and sensitive-data redaction
  providers/      Mock and external provider adapters
  queue/          BullMQ queues and transactional outbox dispatcher
  rate-limit/     Redis-backed atomic rate limits
  repositories/   Tenant-scoped database operations
  services/       Authentication, messages, usage, and Android protocol
  worker/         Message dispatch, webhooks, and status reconciliation
  server.ts       API process entry point
  worker.ts       Background worker entry point
android-agent/    Native Android Simulation and live-gated source variants
tests/            Unit, API contract, security, and worker tests
public/           English/Arabic website and local Cairo fonts
docs/             OpenAPI, Postman, architecture decisions, and design notes
migrations/       Ordered PostgreSQL migrations
```

Additional documentation:

- [Architecture decisions](docs/ARCHITECTURE_DECISIONS.md)
- [Product ideas](docs/PRODUCT_IDEAS_AR.md)
- [UI design brief](docs/UI_DESIGN_BRIEF_AR.md)
