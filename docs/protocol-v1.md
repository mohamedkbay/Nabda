# Nabda phone-owned gateway v1

This is the implementation contract for the free-tier edition. The public website is English-first with an Arabic switch. Cloudflare hosts identity, scoped credentials and command handoff; Android owns the durable SMS queue, bodies, recipients, attempts and part outcomes. Never send a real SMS during development or verification.

## Authentication

Management `/api/*` routes require a trusted browser principal supplied by the hosting adapter; reject anonymous requests and never derive account ownership from caller-supplied identity headers. The independent Worker verifies a Nabda session established with GitHub OAuth; the legacy Sites entry adapts its platform-verified identity. `/v1/*` application requests use an independently issued hashed Bearer API key. `/v1/device/*` uses a different hashed device token. Derive organization from credentials, never trust caller-supplied organization_id. Return raw secrets only at creation, never log them.

## Management API

- GET /api/account -> {organization:{id,name}, user:{name,email}, devices:[], keys:[], usage:{...}}
- POST /api/keys {name} -> {id,name,key}; DELETE /api/keys/:id
- POST /api/pairings {name} -> {pairing_token,expires_at,qr:{version:1,server_url,pairing_token},pairing_url}; token is single-use, short-lived, hash stored.
- GET /api/devices -> {devices}; DELETE /api/devices/:id revokes device and pending authorizations.
- GET /api/messages -> {messages,counts}; metadata only after phone acknowledges handoff.
- POST /api/messages/:id/cancel -> queued cancellation command if already on device, no false cancellation guarantee.

## Application API

- POST /v1/messages with Idempotency-Key and {device_id,to,content,send_at?,expires_at?} -> HTTP 202 {id,status:"accepted",device_id,created_at}. Normalize valid Libyan local forms or E.164; preserve message whitespace. Bound content to 4000 UTF-16 units, explicit error on overflow. Different payload with same org+key ->409. Same payload returns same resource. Reject invalid/expired/revoked device and opted-out recipients. Sandbox true records no live SMS, clearly distinguish it.
- GET /v1/messages/:id -> {id,status,device_id,created_at,updated_at,parts_total?,parts_sent?,parts_delivered?,failure_code?}. Never expose another organization's resource.
- GET /v1/usage -> platform request/command counters, not a claim about carrier monetary cost.
- GET /health -> {status,mode:"phone-owned",version}; no secrets.

## Device protocol

- POST /v1/device/pair {pairing_token,name?,android_version?,app_version?} -> {device_id,device_token,server_url,poll_after_ms:60000}. Pair QR token bound to authenticated account; reuse rejected atomically.
- POST /v1/device/poll with device Bearer {ready,permission_granted,sim_selected,app_version?,android_version?} -> {commands:[{id,type:"message.send"|"message.cancel",message_id,payload:{to?,content?,send_at?,expires_at?,sandbox?}}],poll_after_ms:60000,server_time}. At most 25 commands and bounded response; durable commands repeat until acknowledged. Do not poll while not started by user; use idle backoff. Real sending readiness belongs to phone.
- POST /v1/device/ack {command_ids:[...]} -> {acknowledged:[...]}. Phone must commit commands to its SQLite database first. ACK marks send resource on_device and permanently removes recipient/body from server command payload. Duplicate ACK is harmless. Cancellation ACK means command received, not cancellation achieved.
- POST /v1/device/events {events:[{event_id,message_id,status:"queued"|"processing"|"sent"|"delivered"|"failed"|"cancelled"|"expired"|"outcome_unknown",parts_total?,parts_sent?,parts_delivered?,failure_code?,occurred_at}]} -> {accepted:[event_id,...]}. At most 100; events repeat until server ACK. Scope by current device/organization and preserve monotonic result semantics. Never turn an already sent message back into queued. A late result may resolve unknown; delivered only if all parts are confirmed delivered.

## Android execution

Use a native app, app label نبضة, package ly.nabda.mobile. Foreground remoteMessaging service started by a visible user action. Ask platform SMS/phone permissions, choose explicit active subscription, never silently fall back to another SIM. SMS submission through subscription-bound SmsManager.divideMessage/sendTextMessage/sendMultipartTextMessage. Local SQLite records command IDs, queue, durable attempts, per-part callbacks and pending outbound events. On restart, an attempt that may have reached the modem becomes outcome_unknown; never blindly re-send it. Sandbox never calls SmsManager. Configurable conservative pacing respects platform errors; no OS bypasses. Poll service remains functional without paid push credentials (idle >=60s); optional FCM is a later connector, don't advertise instant push if not configured.

Pair by scanning QR or opening `nabda://pair?server=...&token=...`; support manual server/token fallback. Device credentials protected with Android Keystore AES-GCM. Require HTTPS for remote servers; localhost exception is development only. Reject redirects/credential delivery to a different origin. Support local pause/stop and local contact blocklist. Website stats are separately aggregated, not page length. Pending command storage bounded for free-tier operation; command expiry checked both sides. Platform may temporarily retain recipient/body until durable phone handoff; website must explain this honestly.

## Support copy and details

Support is voluntary and never changes account functionality. Display LYPay `LY93007011011011325337018` and OnePay `011011325337018` verbatim with copy buttons. Arabic: «إذا أفادتك نبضة وأحببت دعم استمرارها، فلفتتك محل تقدير. وجودك واستخدامك لها يكفينا—شكرًا بكل الأحوال.» English: “If Nabda has been useful to you and you'd like to support the work, thank you. There's no need to contribute to keep using it.” No invented payment QR or checkout URL.
