# Nabda Free Starter 0.2.0

Use your own Android phone and SIM as an SMS gateway for your application. Nabda accepts an API request, hands the command to the phone, and reports the phone's results. The phone owns the durable sending queue and message database.

This download is an **integration kit**, not a self-hosted backend installer. It contains an Android APK, two small application clients, a Postman collection, and the actual OpenAPI 3.1 contract. It does not install a Windows controller or start a server on your computer. Use your configured Nabda API origin for requests and the dashboard. The illustrated website is hosted separately. Carrier SMS charges, SIM terms, Android restrictions, and hosting resource allowances still apply. Optional support never unlocks functionality.

## What's included

```text
README.md
api-kit/nabda.mjs
api-kit/nabda.py
api-kit/Nabda.postman_collection.json
api-kit/Nabda.postman_environment.json
downloads/Nabda-Android-0.2.0.apk
downloads/THIRD-PARTY-NOTICES.txt
openapi.json
SHA256SUMS.txt
```

Choose either Node.js 22+ or Python 3; neither client needs npm or pip packages. You do not need both. The APK needs Android 8.0+. Sandbox testing does not require a SIM or SMS/phone permission; those are needed only for carrier sending, which requires an active SMS-capable SIM. Camera access is optional because pairing also supports manual server/token entry. The phone and computer do not need to share a Wi-Fi network when both can reach the hosted HTTPS site. An emulator can test the sandbox protocol but is not evidence of real carrier delivery.

## 1. Connect your phone

1. Open your API server's `/dashboard` and sign in with GitHub. The public explainer is separate from your account dashboard.
2. Download `downloads/Nabda-Android-0.2.0.apk`, transfer it to your phone, and install it. Android may ask you to allow installation from the browser or file manager you used. Only install a file you obtained from the Nabda release. The included checksums help detect accidental changes; they are not a separately signed authenticity guarantee.
3. In the dashboard, create a fresh pairing QR code. It works once and expires after ten minutes. Scan it in Nabda on the phone, or use the manual server/token fallback. Do not share a QR screenshot: it authorizes a phone to join your workspace.
4. For a sandbox test, keep test mode selected and tap Connect to start the phone service. You can pair and process sandbox commands without SMS/phone permission, SIM selection, or carrier readiness. The visible foreground notification indicates the service is running. Only when you choose carrier sending should you grant the required SMS/phone permissions and select an active SIM explicitly. On a dual-SIM phone, Nabda uses the selected subscription rather than silently choosing another one.
5. Keep the phone powered and connected while it receives work. Allow its background service in your phone's battery settings if the manufacturer stops it. This is a user-controlled service, not an invisible guarantee that Android will never stop it.
6. Create an application API key in the dashboard and copy the linked device ID. Store the key privately; it is shown in full only when created. A device token belongs inside the phone and must not be substituted for an application key.

Pairing a phone does not send an SMS. A lost or revoked phone may still have work already handed to its local queue; stop that queue on the phone itself. Revocation stops future cloud access, not an already offline modem operation.

## 2. Configure a client

Set `NABDA_BASE_URL` to your API server's **origin**, such as `https://YOUR_NABDA_API_HOST`, without a path, query string, or embedded credentials. Use the API hostname, not the Netlify website. Both clients reject remote HTTP and redirects so a token cannot be forwarded to a different host. HTTP is accepted only for localhost/loopback development. A phone must be able to reach the actual hosted HTTPS origin; `localhost` on the phone refers to the phone itself.

In macOS/Linux shells:

```sh
export NABDA_BASE_URL='https://YOUR_NABDA_API_HOST'
read -r -s -p 'Nabda application API key: ' NABDA_API_KEY; echo
export NABDA_API_KEY
export NABDA_DEVICE_ID='YOUR_DEVICE_ID'
export NABDA_TO='YOUR_OWN_TEST_RECIPIENT'
node api-kit/nabda.mjs health
# Or: python3 api-kit/nabda.py health
```

The hidden-input `read` form above is for Bash. In Zsh use `read -r -s 'NABDA_API_KEY?Nabda application API key: '; echo` and then `export NABDA_API_KEY`.

In Windows PowerShell:

```powershell
$env:NABDA_BASE_URL = 'https://YOUR_NABDA_API_HOST'
$secureKey = Read-Host 'Nabda application API key' -AsSecureString
$env:NABDA_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
$env:NABDA_DEVICE_ID = 'YOUR_DEVICE_ID'
$env:NABDA_TO = 'YOUR_OWN_TEST_RECIPIENT'
node .\api-kit\nabda.mjs health
# Or: py -3 .\api-kit\nabda.py health
```

Environment variables keep credentials out of command arguments and copied scripts. They are still readable by your process and other sufficiently privileged software; use a secret manager in a deployed application. Clear the session variables when finished. Never put an application key in a public website, mobile bundle, Git repository, URL, screenshot, chat message, or browser local storage. Your backend should call Nabda.

## 3. Test without carrier SMS

Create a UTF-8 file named `message.txt` containing a short test message. Both supplied clients preserve its text and whitespace, including a final newline if your editor adds one.

```sh
node api-kit/nabda.mjs send --content-file message.txt --idempotency-key MY_SANDBOX_REQUEST_0001
python3 api-kit/nabda.py send --content-file message.txt --idempotency-key MY_OTHER_SANDBOX_REQUEST_0001
```

Run **one** of these alternatives for a single test. They explicitly send `sandbox: true`. A sandbox command still counts toward cloud resource allowances and still needs the paired phone's test-mode service to take and simulate the command, but it must not call Android's SMS modem API. Carrier readiness, SMS/phone permission and SIM selection may all remain false for this test. Save the response's `id`:

```sh
node api-kit/nabda.mjs status --id MESSAGE_ID
node api-kit/nabda.mjs usage
node api-kit/nabda.mjs cancel --id MESSAGE_ID
```

The Python commands have the same arguments. On Windows use `py -3 api-kit/nabda.py` if `python3` is not available. Each client makes one HTTP request and does not automatically retry. A local validation or HTTP failure produces a nonzero exit code. Health does not require a token and only confirms the API process is responding; it does not test the database, phone, selected SIM, balance, or carrier path.

Use a stable idempotency key for a single logical message. If a connection times out, retry the **same payload with the same key**. Nabda will return the same resource. Changing any message field while reusing the key returns `409 idempotency_conflict`. A new key means a new message. Keys are scoped to the workspace, so rotating an application API key does not create a new idempotency namespace.

## 4. Live sending is explicit

After reviewing a successful sandbox test, run the same client with a **new logical request key** and `--live` to request a carrier SMS:

```sh
node api-kit/nabda.mjs send --content-file message.txt --idempotency-key MY_LIVE_REQUEST_0001 --live
```

This guide and the starter's tests do not send that command for you. `--live` sets `sandbox: false`; the linked phone must also be started, ready, permitted, and using a selected active SIM. Use recipients who expect your messages and maintain your own consent and opt-out records. An API `202` is durable acceptance, not proof of SMS submission or delivery.

**The raw API itself defaults `sandbox` to false when omitted.** Always set it explicitly. The supplied clients and Postman send request use true by default. The free edition exposes one-message requests; there is no campaign/bulk endpoint or promise of unlimited throughput.

## HTTP request format

All JSON bodies must be objects with `Content-Type: application/json`. Use HTTPS and `Accept: application/json`. An application call uses:

```http
Authorization: Bearer YOUR_APPLICATION_API_KEY
Idempotency-Key: YOUR_UNIQUE_REQUEST_KEY
```

`Idempotency-Key` is mandatory only for `POST /v1/messages`: 8–128 printable non-space ASCII characters. Organization ownership comes from the credential, never from a caller's `organization_id` field. IDs are opaque strings. Datetimes use RFC3339 with an explicit `Z` or numeric timezone offset.

### Create one message

`POST /v1/messages` → **202**, a direct `Message` object with no `data` or `message` wrapper.

| JSON field | Required | Meaning |
| --- | --- | --- |
| `device_id` | Yes | Active linked phone in the credential's workspace; at most 80 characters. |
| `to` | Yes | International number or a supported Libyan mobile form; maximum input length 40. Normalized before idempotency comparison. |
| `content` | Yes | Non-blank text, at most 4,000 UTF-16 units; original whitespace is preserved. |
| `sandbox` | No | Boolean; raw API default false. Set true for modem-free testing. |
| `send_at` | No | Timezone-qualified timestamp; default now; at most 30 days ahead. |
| `expires_at` | No | Future timestamp after `send_at`, at most 31 days ahead; default 24 hours after the later of creation and send time. |

Arabic/Persian digits and spaces, parentheses, and hyphens are normalized in recipients. A `00` international prefix becomes `+`. Libyan mobile forms beginning with a local zero, the national mobile prefix, or country code are accepted when they match the supported format; other countries should use `+` and a country code. This validates format, not whether a number exists, has consented, or can receive SMS. No real recipient is included in this kit.

Example request using placeholders that you must replace:

```json
{
  "device_id": "YOUR_DEVICE_ID",
  "to": "YOUR_OWN_TEST_RECIPIENT",
  "content": "Your test message",
  "sandbox": true
}
```

### Read, cancel, and measure

| Method and path | Authentication | Success | Result |
| --- | --- | --- | --- |
| `GET /health` | None | 200 | `{status:"ok", mode:"phone-owned", version:"0.2.0"}`; liveness only. |
| `GET /v1/messages/{id}` | Application Bearer | 200 | `Message` metadata owned by that workspace. |
| `POST /v1/messages/{id}/cancellations` | Application Bearer | 200 | `{id,status,cancellation_requested:true,guaranteed,note?}`. Empty JSON `{}` is fine. |
| `GET /v1/usage` | Application Bearer | 200 | UTC-day command counters and reported SMS parts, not a carrier bill. |

Every `Message` includes `id`, `status`, `device_id`, `sandbox`, `created_at`, `updated_at`, `send_at`, `expires_at`, `handed_off_at`, `cancellation_requested`, `parts_total`, `parts_sent`, `parts_delivered`, and `failure_code`. Handoff time, part counters and failure code can be null before they are known. Recipient and body are not returned. Save the message ID in your application along with your own business reference, not the full credential.

Usage includes `day_utc`, `accepted_commands`, `reported_sent_messages`, `reported_sent_parts`, `pending_handoffs`, `active_devices`, `carrier_cost: null`, `source: "device_reported"`, and `limits: {new_messages_per_day:1000,pending_handoffs:500}`. Accepted commands include sandbox/cancelled requests, not just delivered SMS. Reported sent counters reflect message rows in sent/delivered status; a partially submitted failed message is not a complete carrier billing ledger. Metadata timestamps are cloud timestamps; event occurrence time originates on the phone.

## Status and delivery meaning

The normal path is `accepted → on_device → queued → processing → sent → delivered`.

| Status | Meaning |
| --- | --- |
| `accepted` | Cloud saved a command durably; the phone has not acknowledged ownership. |
| `on_device` | Phone staged the command and successfully completed the ACK handshake. |
| `queued` | Phone reports that local work is queued. |
| `processing` | Phone reports an attempt is underway. |
| `sent` | Phone reports every SMS part submitted successfully; this is not delivery. |
| `delivered` | Phone reports delivery callbacks for every part; not proof a human read it. |
| `failed` | Phone reports failure. Check `failure_code` and local phone details. |
| `cancelled` | Cancelled before handoff or confirmed locally by the phone. |
| `expired` | Work expired before it could complete. Cloud pre-handoff expiry is observed during phone polling. |
| `outcome_unknown` | Submission may have reached the modem but the result is uncertain. Do not blindly resend. A later valid callback can resolve it. |

Status merges reject stale regressions: delivered stays delivered; sent may advance to delivered; stale queued events cannot undo processing/sent. Failed/cancelled/expired remain terminal. An uncertain result may resolve to sent/delivered/failed. A phone restart around modem submission must become unknown instead of silently producing a duplicate SMS.

Cancellation before a successful handoff ACK can prevent submission. After handoff it is a best-effort command that must reach the phone. `guaranteed:false` means the phone has not confirmed cancellation. A sent SMS cannot be recalled; finished sent/delivered/failed/expired messages return `409 cannot_cancel`. Repeating a confirmed cancellation is harmless.

## Timing, capacity, and SMS parts

- Free workspace allowance: 1,000 new message commands per UTC day, including sandbox commands, and 500 unacknowledged handoffs at once. Existing phone-owned queues are unaffected by a new-command limit. Usage does not mean “free carrier SMS.”
- 20 active application keys per workspace; revoke an unused key to create a replacement. Five unexpired, unused pairing codes per workspace; each expires after ten minutes.
- Request bodies: at most 131,072 bytes (128 KiB). Content: 4,000 UTF-16 units. Android computes actual SMS part count with `SmsManager`; an emoji can occupy two UTF-16 units. Long or non-GSM text may become multiple billable SMS parts.
- Phone poll responses contain at most 25 commands. Idle polling interval is 60,000 ms. No push provider is configured in this edition, so receipt is not instantaneous. Android scheduling, battery restrictions, signal, SIM balance, modem speed and operator policy affect completion.
- Future-dated messages can be handed to the phone early, then scheduled locally. The phone can continue already acknowledged work without Internet, and upload results later. Keep it powered; a cloud API cannot overcome an offline or stopped phone.
- No credible fixed “messages per minute” or delivery deadline applies to every Android phone or carrier. Use the phone's pacing controls and observe real callbacks; do not treat the daily API allowance as a modem speed.

## Postman

Import `api-kit/Nabda.postman_collection.json` and `api-kit/Nabda.postman_environment.json`. Select the imported environment. All its values start blank. Set `base_url`, `api_key`, `device_id`, `to`, `content`, and a stable `idempotency_key` locally. Keep `api_key` marked sensitive/private; do not publish or sync an environment containing real secrets.

Run Health first, then **Send sandbox message**, then Get message or Usage. On a successful 202 the test script saves only `message_id`, never a token. The send body contains literal `sandbox: true`; there is no live-send request in the collection. The collection's pre-request validation rejects blank settings and unsafe remote HTTP origins. Do not use a collection runner as a campaign tool. Reusing the same key is intentional deduplication, not another send.

The collection covers the application API. Pairing, polling, ACKs and event uploads normally belong to the Android app, not Postman. Browser account operations use the signed-in dashboard session rather than your application Bearer key.

## curl and PowerShell

The included clients avoid shell quoting differences. For a read-only usage check on macOS/Linux:

```sh
curl --fail-with-body --max-time 30 --header "Authorization: Bearer $NABDA_API_KEY" "$NABDA_BASE_URL/v1/usage"
```

In Windows PowerShell, `curl` can be an alias for `Invoke-WebRequest`; use **`curl.exe`** for native curl syntax:

```powershell
curl.exe --fail-with-body --max-time 30 --header "Authorization: Bearer $env:NABDA_API_KEY" "$env:NABDA_BASE_URL/v1/usage"
# Or use PowerShell directly:
Invoke-RestMethod -Uri "$env:NABDA_BASE_URL/v1/usage" -Headers @{ Authorization = "Bearer $env:NABDA_API_KEY" }
```

These curl examples expand credentials into process arguments, which may be visible locally. Prefer the included environment-reading clients on shared computers. Do not enable verbose request tracing or paste commands after replacing credentials with their actual values. If native curl lacks `--fail-with-body`, use the clients or upgrade curl; omit that option only if you separately inspect HTTP status.

## All browser management endpoints

These use the platform-managed signed-in browser session in `/dashboard`. They do **not** accept application keys as a replacement for sign-in. The platform establishes identity; never supply or trust an arbitrary user-selected identity header. Mutating calls must originate from the site's own origin. POST creation calls use JSON. There is no public “create an account with an arbitrary owner ID” endpoint.

| Method and path | Input | Success and fields |
| --- | --- | --- |
| `GET /api/account` | None | 200 `Account`: organization `{id,name,created_at}`, user `{name,email}`, devices, key summaries, usage, version. |
| `POST /api/keys` | `{name}` (1–80 characters) | 201 `KeyCreated`: id, name, key, created_at. Full key is returned once. |
| `DELETE /api/keys/{id}` | Key ID | 200 `{revoked:true}`; repeated revocation returns 404 because it is no longer active. |
| `POST /api/pairings` | `{name?}` (default “My Android phone”) | 201 `PairingCreated`: pairing_token, expires_at, qr, pairing_url. |
| `GET /api/devices` | None | 200 `{devices:[Device...]}`; at most 100 listed records. |
| `DELETE /api/devices/{id}` | Device ID | 200 `{revoked:true,note}`; blocks future access and clears pending cloud command contents. Stop already handed-off work on the phone. |
| `GET /api/messages` | Optional `limit` (1–100, default 30), `cursor` from previous response | 200 `MessagePage`: messages, counts by status, as_of, next_cursor (null when finished). Counts are workspace-wide, not page totals. Treat cursor as opaque. |
| `POST /api/messages/{id}/cancel` | Message ID | 200 `Cancellation`; same before/after-handoff guarantees as application cancellation. |

`Device` fields are id, name, status (`active` or `revoked`), ready, permission_granted, sim_selected, app_version, android_version, last_seen_at, created_at, connected. Versions and last-seen can be null. `connected` is a recent-observation hint (active and last seen within three minutes), not a permanent socket or promise of SIM readiness. `KeySummary` fields are id, name, prefix, created_at, revoked_at; the full key is never listed.

The pairing QR contains `{version:1,server_url,pairing_token}`. The deep link is `nabda://pair?server=...&token=...`. Both are credentials with the same single-use, ten-minute scope.

## Device protocol reference

Application developers normally let the supplied Android app implement this section. Do not make a second process poll the same device's queue or upload fabricated delivery events. Device tokens and application keys are separate credentials with separate scopes.

| Method and path | Input | Success |
| --- | --- | --- |
| `POST /v1/device/pair` | `DevicePair`: pairing_token; optional name, app_version, android_version (max 80 each). No Bearer credential yet. | 201 `DevicePaired`: device_id, device_token, server_url, poll_after_ms (60000). QR is consumed atomically once. |
| `POST /v1/device/poll` | Device Bearer; `DevicePoll`: required booleans ready, permission_granted, sim_selected; optional app_version, android_version. | 200 `PollResult`: commands (max 25), poll_after_ms (60000), server_time. |
| `POST /v1/device/ack` | Device Bearer; `DeviceAck`: command_ids array with 1–100 strings (max 100 characters each). | 200 `AckResult`: acknowledged IDs and rejected `{id,reason}` entries. Reasons: cancelled, expired, not_found. |
| `POST /v1/device/events` | Device Bearer; `EventBatch`: events array containing 1–100 DeviceEvent objects. | 200 `EventReceipt`: accepted event IDs. |

A `Command` contains id, type (`message.send` or `message.cancel`), message_id, payload. Send payload is `{to,content,send_at,expires_at,sandbox}`; cancel payload is `{}`. Commands may repeat until acknowledged, including cancellation commands ordered before sends. The phone must store them transactionally in SQLite **before** calling ACK. Poll alone never permits modem submission. Only command IDs present in `acknowledged` become locally executable. Repeating a previously successful ACK returns that ID, even if the first response was lost. Rejected staged commands must not execute.

An ACK atomically checks that the send was not cancelled or expired before ownership transfer, then sets on_device/handed_off_at and purges the server payload. A cancellation ACK only confirms receipt of the request; the phone still reports whether cancellation actually succeeded.

`DeviceEvent` requires event_id (stable, 1–100 chars), message_id (1–80 chars), status (queued, processing, sent, delivered, failed, cancelled, expired, outcome_unknown), occurred_at (timezone-qualified timestamp). Optional fields are parts_total, parts_sent, parts_delivered, failure_code. Counts are integers at most 100; total must be at least 1 when supplied. Supplying sent needs total; supplying delivered needs both sent and total; delivered ≤ sent ≤ total. A sent status requires sent=total; delivered requires delivered=sent=total. Total cannot change once recorded. Failure codes are short symbolic strings (max 80) using letters, digits, underscore, period, colon or hyphen, never message contents.

The phone persists outbound events and retries with the exact same event_id and payload until receipt. Reusing an event ID with changed contents, even inside one batch, returns 409. An event for an unacknowledged message is rejected. A late stale status cannot undo a known later result. Event receipts mean the server recorded the report, not that it independently verified a carrier delivery.

## Errors and retries

Errors use `{ "error": { "code": "symbolic_code", "message": "Readable explanation" } }`. Clients should branch on HTTP status and code, not match English prose. Do not log request headers, recipient/text, pairing tokens or keys during debugging.

| HTTP | Common codes / meaning | What to do |
| --- | --- | --- |
| 400 | `invalid_json` | Send a JSON object, not an array, malformed text or empty body. |
| 401 | `invalid_token`, `sign_in_required`, `invalid_pairing` | Check the correct credential type; sign in or make a fresh pairing QR. Revoked tokens cannot be recovered. |
| 403 | `origin_rejected` | Open the dashboard in its own site tab; do not perform cross-site browser management writes. |
| 404 | `not_found`, `device_not_found` | Check ID and workspace. Foreign resources are not disclosed. |
| 409 | `idempotency_conflict`, `cannot_cancel`, `recipient_opted_out`, `event_conflict`, `handoff_not_acknowledged`, `part_count_conflict` | Correct the underlying conflict; do not blindly create a new send key. |
| 413 | `request_too_large` | JSON body exceeded 128 KiB. |
| 415 | `json_required` | Set `Content-Type: application/json`. |
| 422 | `validation_error`, `invalid_phone`, `invalid_content`, `idempotency_key_required`, `invalid_time`, `invalid_expiry`, `schedule_too_far`, `invalid_cursor`, `invalid_status`, `invalid_part_count`, `incomplete_parts`, `invalid_failure_code` | Correct the named field. Timestamps need a timezone. |
| 429 | `workspace_capacity`, `key_limit`, `pairing_limit` | Check usage; wait for UTC-day reset, phone handoff, code expiry, or revoke an unused key. No Retry-After header is promised. |
| 500 | `internal_error` | Retry a send with the same key and exact payload after a bounded delay. Never assume the command was not stored. |
| 503 | `database_unavailable` | Backend database is not provisioned or available. Try later; liveness can still be green. |

Network timeouts and server errors can occur after acceptance. Your application should persist the idempotency key and original normalized input before creating a message, use bounded backoff, and reconcile by message ID once known. The starter does not automatically resend. Application responses permit CORS, but that does not make a secret safe to embed in a public frontend.

An upstream hosting firewall can return its own error before a request reaches Nabda. For example, Cloudflare `1010 browser_signature_banned` is a hosting access denial, not `origin_rejected` from the API. Both clients identify themselves honestly as `Nabda-Free-Starter/0.2.0` through the User-Agent header. If your own client uses a generic library default, give it a descriptive application identity as explained in [Cloudflare's guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/). Do not repeatedly retry an explicitly denied identity or disguise the client as a browser. If your identified client remains blocked, the site owner must review the access policy for legitimate API clients. Likewise, a browser sign-in page or HTML response at an API URL means you should check the hosting/proxy path rather than parsing it as a successful API response.

## Data, privacy, and current boundaries

The cloud temporarily holds recipient and text in a command until the phone acknowledges durable storage. After successful ACK that command payload is permanently cleared. Message metadata, request hashes, counters and deduplicated event records remain in the cloud. Do not describe the service as “no cloud processing” or end-to-end encrypted. HTTPS protects transport; the cloud must read a pending command to route it.

The phone owns queue, recipients, body text, attempts and local part outcomes. After ACK the cloud cannot reconstruct a message body. There is no encrypted cloud backup/restore of a lost phone in this edition. Protect the handset, its lock screen, backups, and the computer holding your integration settings.

Expired cloud command payloads are cleared on the phone's next poll. There is currently no scheduled retention cleanup job, so an expired command for a phone that never returns can remain until later polling or explicit cancellation/revocation. No exact automatic deletion deadline is promised. Deleting/revoking access cannot erase content already on a phone or recall an SMS.

The server checks an existing workspace recipient-hash opt-out table before acceptance; this edition does not expose public CRUD endpoints for that table. Phone-local blocking controls are available and must be respected before modem submission. Maintain opt-out/consent records in your own application as well. Do not claim an automated inbound STOP workflow or centralized blocklist editor exists when it has not been implemented.

Not included: campaign/bulk API, third-party SMS provider adapter, public webhook delivery service, configured push provider, carrier billing integration, VoIP/PBX calls, incoming-SMS API, multipart read receipts from humans, a Windows installer, or a self-hosted server bundle. `outcome_unknown` is deliberate protection against duplicate submission after an uncertain modem call.

## Responsibility and disclaimer

I develop and maintain Nabda as a software tool for learning and practical integrations. Users choose their own messages, recipients, devices, SIMs and sending decisions. Providing the tool does not mean I endorse or authorize a user's independent actions.

Each user is responsible for their account and API keys, message content, recipient consent, lawful handling of contact data, carrier terms, SMS charges, and the consequences of their own use or misuse.

The software is provided as is and as available, without a guarantee of uninterrupted operation, successful delivery or suitability for a particular purpose, to the extent permitted by applicable law.

To the extent permitted by applicable law, the developer is not liable for users' independent actions, content, recipient lists, unauthorized use, misuse, or losses caused by those actions. This notice does not exclude or limit any duty or liability that applicable law does not allow to be excluded or limited.

This notice does not permit spam, harassment, fraud or unlawful activity. Legal reference: [Libyan Civil Code, Articles 166 and 220, published by the Ministry of Justice](https://www.aladel.gov.ly/home/wp-content/uploads/2016/04/%D8%A7%D9%84%D9%82%D8%A7%D9%86%D9%88-%D9%86-%D8%A7%D9%84%D9%85%D8%AF%D9%86%D9%8A.pdf). Mandatory legal obligations continue to apply.

## Contract, integrity, and support

`openapi.json` describes all 17 implemented operations and their request/response schemas. Import it into compatible API tooling for the full machine-readable field constraints. Public schema names: Error, Health, Message, MessageCreate, Cancellation, Usage, Device, KeySummary, KeyCreated, PairingCreated, Account, MessagePage, DevicePair, DevicePaired, DevicePoll, Command, PollResult, DeviceAck, AckResult, DeviceEvent, EventBatch, EventReceipt.

`SHA256SUMS.txt` covers every other file in the ZIP. Compare a downloaded APK or script with its listed SHA-256 if you suspect an incomplete transfer. On Linux use `sha256sum`; on macOS use `shasum -a 256`; on PowerShell use `Get-FileHash -Algorithm SHA256 PATH`. The release archive is built from an explicit file allowlist; it contains no account database, API key, environment file, server source, node_modules, or private hosting settings.

If Nabda helps your work and you would like to support its maintenance, thank you. You can keep using the free edition without contributing. Optional support details are on the public site; there is no subscription or checkout requirement in this kit.
