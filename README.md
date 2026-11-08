# Nabda

An open-source SMS API that uses your own Android phone and SIM. Your application submits a request, Nabda hands it to your phone, and Android sends the SMS through the SIM you selected.

The service is free to use. Your carrier's SMS charges still apply. Optional support does not change your access or unlock features.

[Website and documentation](https://nabda-phone-api.netlify.app/) · [Account dashboard](https://nabda-api.mohamed-kbay.workers.dev/dashboard) · [API health](https://nabda-api.mohamed-kbay.workers.dev/health) · [OpenAPI](https://nabda-phone-api.netlify.app/openapi.json)

The public website and API are deployed independently on Netlify and Cloudflare. GitHub sign-in and account loading have been verified on the hosted deployment; physical-phone and carrier delivery remain unverified. To host your own installation, follow [the deployment guide](docs/DEPLOYMENT.md).

This repository contains the API, account dashboard, illustrated website, clients and native Android app. Version **0.2.0** is an early release: the supplied APK is debug-signed, and physical-device and carrier testing remains necessary before relying on it for production traffic.

## How a message moves

1. Sign in with GitHub, then create a one-time phone pairing code in the dashboard.
2. Scan it with Nabda Android and choose **Connect in test mode**.
3. Create an application key and submit a request with `sandbox: true`.
4. Android saves the command in SQLite before acknowledging it. Only an approved acknowledgement releases the command for local execution.
5. The API removes the command's text and recipient after handoff. The phone keeps the queue, attempts and SMS-part results, then synchronizes status updates.

The phone can continue received work while its Internet connection is unavailable. New requests still need to reach the phone. A `202` response means a command was saved; it does not mean an SMS was sent or delivered.

| Part | Runs on | Stores or serves |
| --- | --- | --- |
| Public website | Netlify | One illustrated English page, documentation and downloads |
| API and dashboard | Cloudflare Workers | Authenticated requests, pairing, keys and status |
| Account database | Cloudflare D1 | Users, hashed credentials, temporary commands and metadata |
| Android app | Your phone | Durable SQLite queue, full messages, recipients and results |

## Run locally

Install **Node.js 22.13+**, npm and **Python 3**. Docker, PostgreSQL and Redis are not needed for this edition.

```sh
git clone https://github.com/mohamedkbay/Nabda.git
cd Nabda
npm ci
npm run build:independent -- --preview
npm run db:migrate:local -- --preview
npm run dev:cloudflare -- --preview
```

Open `http://127.0.0.1:8787/dashboard`. Preview mode uses an isolated local D1 database and loopback URLs. It cannot deploy, migrate a remote database or set remote secrets. GitHub sign-in needs a separately configured OAuth App; there is no simulated production login. The deployment guide explains optional local OAuth setup.

In a second terminal, preview the website:

```sh
python3 -m http.server 5174 --bind 127.0.0.1 --directory deploy-build/netlify
```

Open `http://127.0.0.1:5174`. This simple file server does not emulate Netlify's redirect and header rules. Android requires HTTPS for pairing, so use a properly configured HTTPS installation for a physical phone.

The shortcuts `npm run build`, `npm run dev` and `npm start` use the independent local preview. Real deployment commands are separate and explicit.

## Deploy your own service

Follow [the Cloudflare and Netlify deployment guide](docs/DEPLOYMENT.md). You need your own Cloudflare, Netlify and GitHub accounts. The guided setup is:

```sh
bash scripts/setup-hosting.sh
```

It connects hosting CLIs through your browser, collects public deployment settings and prepares both builds. It does not publish the service. For manual setup, copy [.env.deploy.example](.env.deploy.example) to ignored `.env.deploy` and fill it in as data; do not execute it as a shell script.

The API and dashboard share one origin. GitHub OAuth uses browser-bound state, S256 PKCE and single-use attempts. Nabda issues its own HttpOnly session; provider access tokens are not stored. Keep the GitHub Client Secret in Cloudflare's secret store. It does not belong in Netlify, the browser bundle or Git.

Builds for deployment use `npm run build:independent` **without** `--preview` after real settings are configured. Preview exports are for localhost and must not be uploaded as a production website. Hosting providers have their own free-plan quotas; see [hosting notes](docs/hosting-options.md).

## First API request

On the [hosted dashboard](https://nabda-api.mohamed-kbay.workers.dev/dashboard) or your own HTTPS installation, sign in, pair your phone and create an application key. In Android choose **Connect in test mode**. Sandbox mode does not need a selected SIM or SMS/phone permission and never invokes carrier sending.

Replace the placeholders with your own values. Keep the key on your application's server.

```sh
curl --request POST 'https://nabda-api.mohamed-kbay.workers.dev/v1/messages' \
  --header 'Authorization: Bearer YOUR_APPLICATION_KEY' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: first-sandbox-message-001' \
  --data '{"device_id":"YOUR_DEVICE_ID","to":"RECIPIENT_IN_E164","content":"Hello from Nabda.","sandbox":true}'
```

Save the returned message ID, then read its status with `GET /v1/messages/{id}` using the same application key. Retry an uncertain request with the **same** idempotency key and payload. Changing the payload with that key returns `409`.

The hosted API base URL is `https://nabda-api.mohamed-kbay.workers.dev`; use your own API origin when self-hosting. The Netlify website is documentation and downloads, not the endpoint for authenticated message requests.

Raw API requests default to carrier mode when `sandbox` is omitted. The provided Node.js, Python and Postman examples explicitly default to sandbox. Real sending also requires the appropriate permissions, an exact SIM selection and an explicit start action in Android.

| Application endpoint | Purpose |
| --- | --- |
| `POST /v1/messages` | Accept an idempotent send command |
| `GET /v1/messages/{id}` | Read metadata and the phone's reported result |
| `POST /v1/messages/{id}/cancellations` | Request cancellation |
| `GET /v1/usage` | Read usage and applicable allowances |
| `GET /health` | Read process version and mode; no credential required |

Application keys and device tokens are separate, random, hashed in D1 and independently revocable. Browser sessions manage accounts, keys and pairing; a caller-supplied identity header cannot authenticate an account.

Read [protocol v1](docs/protocol-v1.md), [the backend guide](docs/backend.md) and [the client guide](public/api-kit/README.md) for fields, management/device routes and result meanings. Each deployed website publishes its generated `openapi.json` and client downloads with its own API origin.

## Limits and delivery behavior

The current shared control plane allows **1,000 new commands per workspace per UTC day**, **500 pending handoffs**, **20 active application keys** and **five valid pairing codes**. Bodies are limited to 128 KiB and SMS text to 4,000 UTF-16 units. These are platform resource allowances. They do not describe carrier pricing or guarantee Android sending speed.

Phone polling is approximately 60 seconds while idle, with longer backoff when offline. Status can progress through `accepted`, `on_device`, `queued`, `processing`, `sent`, `delivered`, `failed`, `expired`, `cancelled` or `outcome_unknown`. Sent and delivered are phone reports; neither proves a person read the text.

If an interrupted modem attempt has no reliable outcome, the app records `outcome_unknown` instead of blindly resending. Cancellation is guaranteed before approved handoff; afterwards the phone must receive and honor it. An already submitted SMS cannot be recalled.

Message text and recipients are removed from the cloud after approved handoff. Unreceived expired content is cleaned when the phone polls, or through cancellation/revocation. There is no scheduled retention job or guaranteed deletion deadline for a phone that never returns. Encrypted phone backup, inbound SMS/contacts sync, public webhooks, push delivery and bulk campaign endpoints are not implemented in this release.

## Android

The app requires **Android 8 / API 26+**. The checked-in APK at `public/downloads/Nabda-Android-0.2.0.apk` is a debug-signed test build. Production signing and store distribution are not configured.

To build from source, install JDK 17+ and Android SDK 36, then run from `android/`:

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest :app:lintDebug
```

Use `gradlew.bat` on Windows. See [Android setup and behavior](android/README.md) and [third-party notices](THIRD_PARTY_NOTICES.md). The APK accepts the API origin from pairing; it is not tied to a particular hosting hostname.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run check:cloudflare -- --preview
```

The API/authentication tests use isolated local D1 and simulated GitHub responses. They cover tenant isolation, credential scopes, idempotency, durable handoff, cancellation, event deduplication, OAuth/session behavior and deployment configuration. They do not contact a real phone, send SMS or deploy code. GitHub Actions runs these checks without deployment secrets.

Physical-phone background endurance, permissions, dual-SIM behavior and carrier receipts require separate testing. See [independent verification](docs/VERIFICATION-independent.md) for what has actually been checked.

## Contributing and license

Nabda is developed by **Mohamed Bay** and released under the [MIT License](LICENSE). Bundled third-party code and fonts retain their own licenses and notices. [Contribution notes](CONTRIBUTING.md) describe the workflow; report vulnerabilities using [the security policy](SECURITY.md).

I provide the tool; you decide how to use it. You are responsible for your messages, recipients, permissions, account credentials, carrier terms and costs. The software is provided without warranty, and liability is limited only to the extent permitted by applicable law. This does not exclude duties or liability that cannot lawfully be excluded.
