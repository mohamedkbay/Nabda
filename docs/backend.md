# Cloud control plane

Nabda's server accepts authenticated commands and hands them to a linked Android phone. It does not submit SMS itself. The phone's SQLite database owns the queue, recipients, text, attempts and per-part results. The cloud stores recipient/text temporarily in `commands.payload_json`; a successful durable-handoff acknowledgement removes that payload permanently. Message rows contain metadata, request hashes and counters, not a copy of the text.

The handler is `handleNabdaApi(request, { DB })` in `lib/nabda-api.ts`. `worker/index.ts` intercepts `/api/*`, `/v1/*` and `/health` before Vinext and preserves Sites' connector binding for ordinary pages. Database tables are migrated through Drizzle; no request creates tables.

## Browser account identity

The shared API accepts an explicit trusted `BrowserUser` from its hosting adapter. It never authenticates browser users from caller-supplied identity headers. In the legacy entry, Sites dispatch supplies the authenticated visitor identity and `worker/index.ts` adapts it. In the independent entry, `worker/cloudflare.ts` strips old identity headers and resolves a hashed-at-rest session issued after verified GitHub OAuth. Stable `github:<id>` identity owns the independent workspace; email/name are profile fields, not tenant selectors. Management and dashboard remain on the API origin. Mutating management calls reject a mismatched Origin or cross-site Fetch Metadata. See [the independent deployment guide](DEPLOYMENT.md).

Application and device traffic does not use browser cookies. API keys and device tokens are random 256-bit values with distinct prefixes, SHA-256 verifiers at rest and independently revocable scopes. A device token cannot create messages or manage keys; an application key cannot claim device commands. Raw credentials are returned only when created. Transport must use HTTPS.

## Public APIs

`POST /v1/messages` requires `Authorization: Bearer <application-key>`, `Idempotency-Key` (8–128 printable characters) and JSON `{device_id,to,content,sandbox?,send_at?,expires_at?}`. The message is durably saved before `202`. The same workspace/key/payload returns the original resource, including after API-key rotation. A changed payload conflicts. A unique database index handles concurrent submissions. Whitespace is preserved in content; numbers normalize to E.164, including Libyan local forms and Arabic digits.

`GET /v1/messages/:id` returns metadata and reported outcomes. `POST /v1/messages/:id/cancellations` cancels before handoff, or creates a request for the phone to decide if it has already taken responsibility. `GET /v1/usage` distinguishes new commands, pending handoffs and device-reported sent parts; it never estimates a carrier bill.

Free-edition control-plane resource allowances are 1,000 newly accepted commands per workspace per UTC day, at most 500 unacknowledged handoffs, 20 active application keys and five simultaneously valid pairing codes. These are platform allowances, not an Android speed guarantee, and do not count cancelled messages as successfully transmitted SMS. See `/v1/usage` for the applicable command limits. The root site copy must describe these resource limits accurately instead of advertising unlimited backend capacity.

Bodies are bounded to 128 KiB; SMS text is bounded to 4,000 UTF-16 units; the receiver phone computes actual SMS parts. Schedules are bounded to 30 days, expiry to 31 days. Default expiry is 24 hours after the later of creation/send time. A phone may take a scheduled message before its scheduled time because it owns the scheduler.

## Handoff and cancellation

`POST /api/pairings` creates a random, one-use token lasting ten minutes. QR JSON is `{version:1,server_url,pairing_token}` and the deep link uses `nabda://pair?server=...&token=...`. `POST /v1/device/pair` atomically consumes it and creates an organization-bound phone credential. Pairing again requires a new token.

The Android foreground service calls `/v1/device/poll` with readiness fields. Up to 25 durable commands are returned; they may repeat. Polling alone does **not** authorize SMS execution. The phone stages them transactionally in SQLite, then calls `/v1/device/ack`. Only IDs returned in `acknowledged` become eligible for local execution. IDs in `rejected` are terminalized according to the reason. A duplicate legitimate ACK returns the same ID, handling a lost HTTP response.

ACK atomically verifies the still-eligible send, records `handed_off_at`, and purges the cloud command payload. Cancellation between poll and ACK blocks that handoff. Cancellation after ACK is best-effort, must reach the phone, and never promises recall of a submitted SMS. Revoking a device blocks future cloud operations but cannot instantly stop work that an offline phone already owns; stop that queue on the phone itself.

After handoff the phone can operate without Internet. It retains outbound events and retries their upload later. A restart around a modem call must result in `outcome_unknown`, not automatic resubmission.

## Events

`POST /v1/device/events` accepts batches up to 100 events. Each includes a stable `event_id`, `message_id`, symbolic `status`, RFC3339 `occurred_at`, optional part counters and a short symbolic `failure_code`. The phone must acknowledge the command first. Counters must be consistent; `sent` requires every part sent and `delivered` every part delivered. The aggregate status cannot regress from sent/delivered on a stale queued event. A late valid result can resolve unknown.

The server deduplicates `(device_id,event_id)` and rejects reuse with changed contents, including conflicts in the same batch. Status merging happens inside the database transaction rather than a stale read/CAS that could acknowledge and then lose an event. These are phone-reported outcomes, not an independent carrier attestation or proof that a human read a message.

## Storage and privacy limits

Expired handoffs are purged when the phone next polls. In this first edition there is no scheduled retention job; a phone that never returns can leave an expired command payload until explicit cancellation/revocation or a later cleanup. Do not claim an exact guaranteed deletion deadline without adding a bounded scheduled cleanup. After ACK, cloud GET/history cannot recover a message body from metadata; it lives on the phone. Encrypted backup/restore of a lost phone is not implemented in this edition.

The cloud opt-out table stores normalized recipient hashes, and acceptance checks it. Phone-local blocking is additionally required before submission. There is no bulk/campaign endpoint, public webhook delivery service, push provider configuration or carrier billing integration implemented here. Idle device polling is 60 seconds; an unconfigured push service must not be advertised as immediate delivery.

## Local verification

Apply the generated `drizzle/0000_windy_sage.sql` through the local D1 migration flow before serving API routes. Never point protocol tests at a real sending device. The sandbox flag is part of the durable command and must never invoke `SmsManager` on Android.

Run `node tests/d1-smoke.mjs` for an isolated Miniflare/real D1 protocol smoke. It applies the generated migration to a new ephemeral database and checks authentication, pairing reuse, idempotency conflict, payload purge after ACK, event reporting and cancellation between poll/ACK. It never contacts a handset or production endpoint. Independent broader protocol tests live in `tests/verification-api.mjs`.

The implemented HTTP contract is downloadable at `/openapi.json` (OpenAPI 3.1), generated by `node scripts/generate-openapi.mjs`. Application and device Bearer credentials are separate schemes. The browser session scheme describes Sites' opaque Cookie transport and trusted dispatch boundary, not a caller-selected identity header or a new OAuth endpoint. The document includes all implemented management routes, handoff rejection responses, sandbox semantics, platform allowances, and explicit privacy/transport limitations.
