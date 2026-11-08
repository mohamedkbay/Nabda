# Nabda verification record

This file records the checks for the first free-tier, phone-owned edition. A planned check is not a passed test. No real SMS is sent during verification.

## Scope and boundaries

- The public site explains the service, downloads, documentation and voluntary support.
- The cloud holds account/device credentials, temporary commands and result metadata.
- Android owns message content, recipients, the durable execution queue and attempt/part history after handoff.
- Remote Android testing requires a physical device and a deliberately authorized recipient; neither is assumed by local tests.

## Required integration checks

| Check | Pass condition |
| --- | --- |
| Anonymous management | `/api/account`, key creation and pairing creation reject anonymous requests. |
| Application/device key separation | App keys cannot use device endpoints; device tokens cannot create app messages or management resources. |
| Pairing race | A one-use token creates exactly one device, including concurrent requests. Expired tokens fail. |
| Idempotency | Same organization, key and payload returns one resource; changed payload conflicts; concurrent duplicates cannot create two send commands. |
| Resource isolation | A second organization cannot read, cancel, poll, ACK or report events for the first organization's device/message. |
| Durable handoff | Poll repeats an unacknowledged command; after the device has committed and ACKed, the cloud command contains neither recipient nor text. |
| Duplicate ACK/event | Repeated delivery cannot duplicate a message or regress its status. |
| Cancellation | Pre-handoff cancellation prevents execution; post-handoff cancellation remains a request until phone outcome is known. |
| Status provenance | Phone reports are labeled as device-reported; missing reports do not prove failure or delivery. |
| Multipart aggregation | Delivered requires confirmation for all parts, and partial/unknown results remain distinguishable. |
| Input bounds | Malformed phone, oversize/empty text, invalid date and excessive batch size return explicit client errors. |
| Expiry/revocation | Expired commands and revoked device credentials cannot start new work. |
| Real-send boundary | Sandbox never reaches `SmsManager`; interrupted started attempts are not automatically resent. |
| Free-tier behavior | Idle polling is at least 60 seconds; no paid push credential or service is required to begin. |

## Current public website checks

- The public story is English-only, including the product name Nabda.
- The root is literal static HTML with no React scripts, header, footer, navigation, menu, forms, buttons, or Connect CTA. The separate account dashboard remains an application.
- Public legacy routes redirect to existing story anchors. Ordinary inline links resolve without creating SMS work.
- Support is optional and never changes permissions, quota or feature access.
- LYPay is exactly `LY93007011011011325337018`.
- OnePay is exactly `011011325337018`, including its leading zero.
- Support details retain the full values and leading zero. No made-up payment URL or payment QR code is presented.
- Privacy copy discloses temporary server command storage before the phone acknowledges handoff.
- Downloads must lead to an actual packaged artifact. Debug signing and physical-device verification limits must be stated honestly.
- Check desktop and mobile rendering together, static text contrast, image descriptions, overflow, browser errors and failed assets.

## Deployment preparation

The Sites manifest must preserve project identity and use logical D1 binding `DB`. Generate schema-only Drizzle migrations and their metadata before the build. Do not create or alter migration-owned tables during request handling. The built Worker must remain at `dist/server/index.js`; preserve the Sites/Vinext integration.

For local D1, build first to emit `dist/server/wrangler.json`, then apply each pending migration once with the starter's local D1 command and `--persist-to .wrangler/state`. Hosted migrations are applied by Sites independently. A local pass does not prove the production database has been migrated.

Do not include `.env`, credentials, Gradle caches, SDKs, local database state, test output or publication archives in uploaded source. Keep authored Android source and intended downloadable APKs only.

## Available verification tooling

Verified on this host: Node.js v25.8.2, Google Chrome, and the bundled Playwright package. The browser harness uses the supplied loopback preview URL and writes screenshots/results to ignored `outputs/qa/`.

## Results

On 8 November 2026, `node tests/verification-api.mjs` passed 26/26 isolated integration checks against the actual API handler bundled into a local Miniflare Worker and fresh D1 database. Every created message used `sandbox: true`; the harness contains no phone transport and cannot send SMS.

The passing checks cover anonymous rejection, credential hashing/non-disclosure, CSRF rejection, concurrent single-use pairing, expired pairing, credential type separation, idempotent and concurrent creation, cross-organization/device isolation, input/request bounds, command redelivery, event-before-handoff rejection, ACK content purge and repetition, multipart validation, event deduplication/conflicts, monotonic and concurrent status updates, cancellation between poll and ACK, post-handoff cancellation semantics, expiry, independent global counts/cursor pages, and key/device revocation.

The test harness injects identity headers to simulate the trusted Sites dispatch layer. That is not a claim that direct caller-provided identity headers are safe. The separate local preview/browser checks must confirm the Sites middleware strips those headers and establishes browser identity through its supported sign-in path.

Android source was reviewed for the ACK execution gate, durable attempts and callbacks, subscription-specific SMS submission, credential storage, HTTPS/origin validation and local stop. Physical Android behavior and actual carrier delivery remain unverified.

The first website design passed 11/11 browser groups at `http://127.0.0.1:5173` on 8 November 2026. Checks covered desktop 1440×1000/mobile 390×844 in English and Arabic, public routes and nested documentation, topic search/navigation, language persistence/direction, exact support clipboard values, absence of invented payment links/QR, real APK download bytes, middleware rejection of forged identity headers, supported local sign-in, QR/key creation, sandbox handoff, and activity metadata. There were no uncaught app errors, failed assets, or horizontal overflow. Local QA credentials were revoked afterward. Screenshots/results are under `outputs/qa/`.

The final illustrated redesign then passed the same 11 browser groups in UI-only mode: dashboard tabs/history were checked without creating keys, pairing devices, or submitting any message command. Desktop/mobile English and Arabic home pages were inspected as full-page screenshots. The menu was subsequently revised to use a single circle trigger, no duplicate inline header navigation, and panels assembling from distinct directions over a transparent overlay. Its targeted final rerun passed 4/4 groups on desktop/mobile, including reduced motion and browser errors. Visible trigger, initial focus, forward/backward keyboard wrapping, Escape dismissal, restored trigger focus, scroll lock/release, deferred menu-link navigation, and locale switching passed in both languages. Normal-motion checks waited for `data-motion-state="open"` and the reverse close transition; reduced-motion checks found no active animations. Intermediate screenshots at approximately 200 ms and stable menu screenshots were inspected. There were no uncaught app errors, failed assets, or horizontal clipping. Final screenshots are `outputs/qa/final-*.png`; `final-browser-results.json` records the broad pass plus the earlier focus-loop finding, and `final-menu-results.json` records its closed, passing final rerun.

Hosted authentication, migrations, downloads, and physical-device behavior remain separate checks; local success does not prove a hosted deployment is ready. No real SMS was sent, and the final redesign pass did not create any SMS commands.

## Final static story

The later English-only, static single-page design supersedes the interactive public layouts above. On 8 November 2026, one batched Chrome pass at 1440×1000 and 390×844 plus one targeted harness confirmation closed all eight check groups. The initial harness was corrected to scroll lazy-loaded scenes into view and normalize absolute redirect locations; no site source fix was required.

Verified: literal root HTML without scripts/React/Arabic/application chrome, substantive API content, four loaded and described scenes, no horizontal overflow, WCAG AA contrast for measured HTML text, working inline links and legacy-route anchors, root GET/HEAD behavior, healthy API mode, and anonymous management rejection. Support details were checked in source against the exact requested LYPay and OnePay values. Full-page screenshots and the new scene crops were visually inspected. There were no browser errors, broken assets, or attempted writes. The harness blocks non-GET/HEAD browser requests before they reach the server.

Run `node tests/verification-static.mjs` against the loopback preview. Evidence is under `outputs/qa/story/`: `static-desktop-full.png`, `static-mobile-full.png`, four scene crops per viewport, `static-results.json`, and the passing targeted `static-fix-results.json`.

The subsequent cutout/pattern/support revision passed one targeted desktop/mobile browser batch (7/7 groups). All four served `*-cutout.webp` files decoded as RGBA with real transparent regions and loaded successfully. Pixel inspection found alpha minimum 0, 45–68% fully transparent pixels, workshop exterior corners all 0, and other cutouts with at most 1/255 opacity at one or two bottom corners. This near-zero soft alpha is recorded explicitly; the inspected artwork has no visible rectangular backdrop or frame halo. The subtle SVG pattern is visible, and measured HTML text passed WCAG AA contrast against both the paper color and a conservative strongest pattern tint of RGB(232,234,227).

Native support details start collapsed on both viewports. One click reveals the exact LYPay and OnePay details, updates the summary label, and Space/Enter can collapse and reopen them. No JavaScript or buttons were added. Opening, setup, queue, parts, and collapsed/expanded support screenshots were inspected with no horizontal overflow, missing assets, browser errors, or attempted writes. Evidence is `outputs/qa/cutouts/`, including `browser-results.json` and `alpha-results.json`; checks are `node tests/verification-cutouts.mjs` and `python3 tests/verification-cutout-alpha.py` (Pillow required).

Public website QA is complete for this frozen version; hosted and physical-phone checks remain separate.

## Hosted smoke checks

The public deployment succeeded at `https://nabda-phone-api.mohamed-kbay.chatgpt.site`. The real hosted `/health`, homepage, `/docs/messages`, `/openapi.json` and APK route returned 200; anonymous `/api/account` returned the expected 401. The Sites database viewer confirmed the live `DB` binding and all eight application tables. The downloaded APK SHA-256 matched `ea9821e6efd2ae066bb003ee591074ed5134b67a5f9a4d2a116d8c0829f28244`.

Node fetch, curl, Python requests-style and Android-style user agents reached hosted health. Python's default urllib user agent returned Cloudflare 403/1010 before reaching the application. The documented client setup now includes a descriptive application User-Agent header; this is Cloudflare's recommended resolution, not a change to authentication. Full hosted ChatGPT sign-in and pairing on a physical Android device remain unverified. No hosted SMS command was created by these checks.

## Free-edition release validation

The existing isolated Miniflare/D1 suite was run once for the release and passed 26/26 checks. A review then found that active API-key capacity used a separate count/read before insertion. The localized fix checks the 20-active-key allowance within the same conditional SQL insert. Its focused isolated D1 regression passed: starting with 19 keys, 20 concurrent requests produced exactly one 201 and 19 responses with 429; revoking one key permitted exactly one replacement. The conditional SQL and organization scope were independently reviewed. No phone transport or real SMS was involved.

Both the running loopback preview and public deployment returned `/health` 200 with phone-owned mode/version 0.2.0, and `/api/account` returned 401 without visitor authentication. An explicitly authorized hosted probe using an official Sites service-access bypass also received 401 at account preflight, before creating keys, devices, or messages. Service access supplies no authenticated visitor identity; this is the expected identity boundary, not proof of a complete hosted visitor workflow. No caller-supplied identity headers or extracted browser cookies were used.

`tests/verification-free-release.mjs` supports explicitly authorized hosted-visitor or local-development sandbox verification. It accepts configuration only through a masked stdin prompt, never token files/arguments/environment, and never logs credential values. Hosted mode requires an expressly supplied authenticated visitor cookie. Local mode obtains its development cookie through the supported loopback Sites sign-in route, keeping it in memory. Neither mode uses forged identity headers. The emulator has no physical modem, creates only one sandbox send, reports queued/cancelled rather than delivery, and revokes its disposable key/device in `finally`. Local-mode success must not be described as proof of hosted ChatGPT authentication or carrier sending.

The authorized local emulator completed 9/9 checks against the running application, using the supported local sign-in cookie and a disposable simulated device. Readiness, SIM selection, and SMS permission were all false. One sandbox request, its idempotent replay, command redelivery, repeated ACK, metadata read, deduplicated queued event, cancelled event, history, usage, and post-revocation rejection passed. Both disposable credentials were revoked; cleanup errors were empty. `outputs/qa/free-release/local-protocol-results.json` explicitly records local mock authentication, no physical phone, no carrier submission, no delivery claim, and no proven hosted visitor-authentication flow.

The frozen download/documentation additions passed one focused desktop/mobile browser batch (3/3 groups) with no API mutations. The English/Cairo static page still has no scripts, header, footer, navigation, buttons, or forms; support details remain collapsed; all four cutouts load; added request-field/client sections and the mobile parts scene fit without document overflow. Raw API `sandbox` default false versus starter/Postman default true, placeholder replacement/E.164 guidance, nullable counters, and sandbox permission guidance were checked. Three stale SIM requirements in the source README were corrected to match actual sandbox behavior; the public kit guide was already correct.

The served ZIP was independently downloaded and verified at 1,250,513 bytes, SHA-256 `274f49c0631b4bae6e39c81721a796e343f9342c3a27baa4774bf5c69cdc0834`. It has exactly eight allowlisted files with valid ZIP CRCs; all seven internal file checksums and their separate public downloads match. The sidecar checksum matches the archive. OpenAPI contains 17 operations, nullable part counts and the actual default; the Postman environment is blank with the API key marked secret, and its send setup explicitly uses sandbox. Both clients default to sandbox. Read-only checks are `python3 tests/verification-release-kit.py` and `node tests/verification-release-ui.mjs`. Evidence/screenshots are under `outputs/qa/free-release/`, including `kit-verify-results.json` and `release-ui-results.json`.

Remaining boundaries are implemented-feature limits, not failed release tests: no hosted authenticated-visitor end-to-end proof yet; no physical Android/carrier/endurance test; no configured FCM/webhook delivery, public campaign API, cloud opt-out CRUD/editor, scheduled retention job, or encrypted phone backup. The ZIP is an integration kit with a debug-signed APK, not a self-hosted backend or Windows installer.

## Responsibility notice update

The subsequent disclaimer change received only a focused desktop/mobile check at `/#disclaimer` and a release-integrity check. Both viewports displayed the English text without horizontal overflow; support details remained collapsed, and there were no browser errors or attempted writes. The notice retains the qualification “to the extent permitted by applicable law” and explicitly preserves duties/liability that cannot be excluded or limited. This check confirms rendering and text presence, not legal enforceability, immunity, or an interpretation of the linked legislation.

The regenerated ZIP is 1,251,076 bytes with SHA-256 `208e78d6207b9256289ef817cee2d39599b42ca33c368a7c6f1ced5334453937`. All eight files have valid CRCs, the seven internal checksums and sidecar checksum match, and its guide matches the separate public guide. All five notice paragraphs match between the webpage and guide after normalizing Markdown link markup and whitespace. No API/client/broad test suite was repeated. Evidence: `outputs/qa/disclaimer/{desktop-disclaimer,mobile-disclaimer}.png`, `browser-results.json`, and `kit-results.json`. One-off verification harnesses are retained with the ignored evidence.
