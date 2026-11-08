# Independent free hosting for Nabda

Reviewed: **2026-11-08**. The comparison below informed the independent deployment. On **2026-11-09**, the owner deployed the [Netlify website](https://nabda-phone-api.netlify.app/) and [Cloudflare API](https://nabda-api.mohamed-kbay.workers.dev/health), migrated a fresh D1 database, and completed real GitHub sign-in with authenticated account loading. Physical-phone and carrier delivery remain unverified; no real SMS has been sent. Follow [DEPLOYMENT.md](DEPLOYMENT.md) to host your own installation.

## Recommendation

Use **Netlify Free for the static illustrated website** and **Cloudflare Workers Free + D1 in the owner's own Cloudflare account for the API**. This separates the website provider from the API provider and removes the OpenAI Sites hosting and sign-in dependency after the migration below. This is a fit for Nabda's current phone-owned queue, not a claim that one host is best for every API.

Keep the authenticated management dashboard on the API origin initially. The Netlify page can link to it, while Android and application clients call the API directly. This avoids introducing cross-site session cookies just to separate the marketing website from the backend.

## Verified free-plan boundaries

| Service | Included allowance | Practical implication |
| --- | --- | --- |
| Cloudflare Workers Free | 100,000 requests/day; 10 ms CPU per invocation | Phone polling, handoff, events and application calls all consume requests. External I/O waiting is distinct from CPU execution. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare D1 Free | 5 million rows read/day; 100,000 rows written/day; 5 GB total account storage | Database operations have their own allowance. Index maintenance also consumes writes; exhausting the daily allowance makes queries fail until reset or upgrade. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 database limit | 500 MB per database; 10 databases on Free | The 5 GB account allowance does not mean one free database may grow to 5 GB. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Netlify Free | 300 credits/month, with a hard limit and no auto recharge | Production deploys cost 15 credits each, bandwidth 20 credits/GB, requests 2 credits/10,000. Downloads and illustrations use that budget too. [Free plan](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), [credit usage](https://www.netlify.com/pricing/) |

These allowances describe hosting, not an SMS allowance or carrier delivery rate. The free plan cannot support an unlimited public audience. Nabda's current per-workspace limits are separate from the host's account-wide quota.

## Why this matches the existing implementation

- `lib/nabda-api.ts` already uses Fetch `Request`/`Response`, Web Crypto and a `D1Database` binding. It does not require a permanent Node process, Redis or a cloud message worker. Android owns the durable sending queue.
- `db/schema.ts` and `drizzle/0000_windy_sage.sql` already describe SQLite/D1 tables and migrations. Moving to a conventional PostgreSQL host would require additional database work.
- `content/story.html` and the assets under `public/` form the independent static website. They can be packaged for Netlify without sending the Vinext API runtime there.
- Android's `Api.java` and `ServerPolicy.java` accept a configured HTTPS origin; `MainActivity.java` reads that origin from manual pairing or QR. It is not locked to the existing `chatgpt.site` hostname.

This compatibility is the main reason for recommending Workers over rewriting the current backend for another free container service.

## Migration preparation and remaining cutover

1. **Independent authentication is implemented.** The shared API requires an explicit trusted browser principal. `worker/cloudflare.ts` ignores old platform identity headers and verifies a Nabda session established through GitHub OAuth with state, browser binding and PKCE. `worker/index.ts` alone retains the trusted legacy Sites adapter during cutover.
2. **Independent configuration is implemented.** `scripts/cloudflare-config.mjs` generates user-owned Wrangler configuration from public coordinates in ignored `.env.deploy`. `worker/cloudflare.ts` does not import the old Sites/Vinext/connector runtime. The owner must still select the actual D1 database, apply migrations and set the OAuth secret.
3. **The static Netlify export is implemented.** `scripts/build-netlify.mjs` emits only the public guide, required assets and downloads to `deploy-build/netlify`, with links to the API dashboard. The single-page design, legal notice and hidden optional support details are preserved.
4. **Origin replacement is implemented at export time.** Canonical/OG URLs, API examples, OpenAPI, starter instructions and ZIP checksums use the configured independent addresses without changing the old live edition. QR already uses the API request origin. The owner must supply real origins before uploading a non-preview build.
5. **Plan the cutover.** Establish the user's external hosting accounts, choose their available free subdomains or owned domain, and deploy a staging API. Either migrate cloud records through an authorized export with stable owner mapping, or explicitly re-pair phones and issue fresh API keys. Changing the URL alone does not move accounts, keys or cloud records. Preserve already-received phone queue/history and avoid reissuing accepted SMS commands.
6. **Verify before switching links.** Use sandbox messages to test independent sign-in, organization isolation, app keys, QR pairing, poll/save/ACK, event deduplication, cancellation and status. Check direct requests cannot forge the old identity headers. No real SMS is required for the hosting migration tests.

If the dashboard is later moved to Netlify too, its current relative `/api/*` requests and same-origin mutation checks must be redesigned deliberately. Use a narrowly allowed website origin and an appropriate verified session flow; the public API's wildcard CORS header is not a substitute for browser account authentication.

## Capacity note

The current server advertises 60-second idle polling (`POLL_AFTER_MS` in `lib/nabda-api.ts`), so a continuously connected idle phone produces approximately **1,440 polls/day**. Ten such phones produce about **14,400 polls/day**, before messages, events, retries and dashboard activity. This is arithmetic based on the current interval, not a load-test result or a guaranteed phone capacity. Measure both request and D1 row usage, avoid unnecessary writes, and consider adaptive polling/push as usage grows.

For a new self-hosted installation, the operator must authenticate to their own provider accounts before creating resources. The reference deployment's availability is recorded above. No password or access token should be pasted into chat.
