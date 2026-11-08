# Independent hosting verification

Initial preparation: **2026-11-08**. Independent deployment and owner sign-in verification: **2026-11-09**. The earlier checks below used local test resources; the deployment update records the subsequent live-host checks. No real SMS was sent.

## Independent deployment update — 2026-11-09

The owner has now provisioned and deployed the independent installation:

- Website and downloads: [nabda-phone-api.netlify.app](https://nabda-phone-api.netlify.app/).
- API and dashboard: [nabda-api.mohamed-kbay.workers.dev](https://nabda-api.mohamed-kbay.workers.dev/dashboard).
- A fresh Cloudflare D1 database has received both checked-in migrations. GitHub OAuth configuration is registered and its secret is stored in Cloudflare.

Public read-only checks returned **200** for the website, API `/health`, dashboard shell and OpenAPI download; anonymous `/api/account` returned **401**. Health reported `mode: phone-owned` and version `0.2.0`; the downloaded OpenAPI names the actual Cloudflare API origin.

The owner completed the real GitHub authorization flow on the deployed Cloudflare origin. Its callback returned to the dashboard, the authenticated account loaded successfully, and the API-key tab loaded. The account had no paired phones, application keys or message usage. This check created no application key, paired no phone and sent no SMS. Local screenshot evidence is retained under ignored `outputs/qa/oauth/cloudflare-owner-signin.png`; it is not part of the public source export.

Live sign-in exposed an upstream-fetch configuration difference: Workers rejects the `redirect: error` mode used initially. The implementation now uses `redirect: manual` and treats upstream redirects as failed authentication instead of forwarding credentials. The focused actual-runtime regression passed, and the corrected Worker was deployed before the successful owner sign-in.

No physical-phone or real carrier delivery has been verified for this deployment. A dashboard sign-in does not prove the Android handoff or carrier path.

The earlier preparation results below describe their original local scope; statements that hosting was pending refer to that stage, not the current deployment update.

## Results

| Check | Result |
| --- | --- |
| `node tests/verification-independent.mjs` | **11/11 groups passed**, including logout/origin hardening and a regression for the real Workers fetch redirect-mode compatibility issue found during live sign-in setup. Authentication and protocol checks use isolated D1 with injected GitHub responses; they do not prove a real account signed in. |
| `node tests/verification-api.mjs` | **26/26 passed** after replacing the test harness's legacy identity-header assumption with an explicit trusted principal. |
| `node tests/verification-key-cap.mjs` | Passed: concurrent key creation stays at 20 active credentials, and revocation permits one replacement. |
| `node tests/verification-deployment.mjs` | **8/8 passed**: deployment configuration guards, preview isolation and rejection of remote actions in preview mode. |
| Local Wrangler D1 migrations | Both checked-in migrations applied successfully to the separate `.wrangler/independent` preview state: 31 SQL commands. |
| Actual local Worker startup | Passed at `http://127.0.0.1:8787` after aligning the compatibility date with the pinned runtime. |
| `node tests/verification-independent-ui.mjs` | **6/6 groups passed**: export integrity plus desktop/mobile website and real Wrangler dashboard checks. Zero page errors, CSP violations, missing assets, writes or external requests. |
| Build checks | Independent dashboard build and Wrangler dry-run succeeded. The independent bundle contains no Sites/Vinext connector or trusted-platform identity adapter. Full TypeScript and focused ESLint checks passed during preparation. |
| Source hygiene | `git diff --check` and syntax checks on the changed test scripts passed. |

The first actual startup exposed a configuration problem that a dry-run could not catch: the pinned local `workerd` supports compatibility dates through 2026-05-22, while the initial generated configuration selected 2026-11-08. The configuration now deliberately uses the previously verified **2026-05-15** date. No dependency upgrade was needed.

Final configuration review also made `--preview` independent of production values in `.env.deploy`: it fixes both origins to loopback, uses the `nabda-api-preview` Worker/database name and dummy local database ID, and ignores the production GitHub Client ID. A deliberately separate `NABDA_PREVIEW_GITHUB_CLIENT_ID` is available for explicit local OAuth setup. Preview commands reject remote deployment, remote migrations and secret publication. After this change, the preview exports were rebuilt, local migrations were confirmed up to date, and the owned local Worker was restarted. Focused real HTTP confirmation returned health **200**, dashboard **200**, anonymous account **401**, and forged legacy identity **401**. The full protocol/browser suites were not repeated for this configuration-only correction.

## Authentication and protocol evidence

The independent tests check that callers cannot authenticate by supplying old `oai-authenticated-*` headers. Authentication uses a verified server-side session, a host-only Secure/HttpOnly/SameSite=Lax cookie, a hashed token in D1 and an independently verified GitHub account. Browser-bound OAuth state, the actual S256 PKCE verifier/challenge pair, expired attempts, mismatched state/cookies, concurrent callback replay, verified email requirements, session tampering/expiry and logout invalidation all passed. Cross-site logout and account mutations were rejected; logout also invalidates an unfinished OAuth attempt from that browser.

Two independently authenticated fixture accounts exercised tenant isolation, application keys, QR pairing with the new API origin, a sandbox message, idempotent retry, polling, durable ACK and content purge, deduplicated queued events and isolated history. The simulated phone reports no SMS permission or selected SIM. Nothing invokes Android, a carrier or a real recipient.

The broader protocol suite still covers credential separation, pairing races, message validation, scheduling/expiry, cancellation before and after handoff, multipart validation, monotonic statuses, event deduplication, pagination and credential revocation.

## Export and browser evidence

The Netlify export contains independent site/API origins and a GitHub account guide. OpenAPI still documents **17 implemented operations**, now using the independent browser-cookie scheme. After the public-license packaging update, the starter ZIP has **9 entries**, all **8 internal file hashes** match both the manifest and the exported public files, and its sidecar SHA-256 matches the archive. No existing accounts, keys, phone data or local database state are included.

The browser check uses the generated Netlify Content Security Policy. Desktop (1440 px) and mobile (390 px) preserve the single static English article, Cairo, four transparent cartoon illustrations, the developer disclaimer and support details collapsed by default. Native support disclosure opens and closes. Resource links work, the article and dashboard fit their viewports, and the real local dashboard displays GitHub sign-in while `/api/account` returns 401 anonymously. Browser writes and external requests are blocked by the harness.

Evidence is generated under ignored `outputs/qa/independent/`: `api-results.json`, `ui-results.json`, `export-results.json`, `preview-isolation-results.json`, and desktop/mobile screenshots for both the article and dashboard. Preview artifacts are under ignored `deploy-build/`; rebuild them with real provider URLs before publishing.

## Remaining verification

- Cloudflare/Netlify deployments and remote D1 migrations are complete. Sustained production capacity and provider quota usage have not been measured.
- Existing cloud accounts/credentials were not migrated. Cutover must explicitly decide between a verified migration and fresh API keys/phone pairing; changing a URL alone does not move those records.
- Physical Android pairing, SIM selection, background endurance, carrier submission and delivery have not been re-tested. A sandbox or `sent` fixture is not proof of real SMS delivery.

## Public-source and license packaging confirmation

On **2026-11-09**, the independent source snapshot was built and type-checked in an isolated worktree based on the existing GitHub repository's history, with no `.openai` creator configuration. Default preview build and the Wrangler dry run passed there. The public README, MIT license, contribution/security documents and CI configuration describe the independent API service; live deployment availability is recorded above.

The Android development APK was rebuilt offline to embed its dependency notices. The manifest, signing certificate and normalized symbolic DEX instructions match the previous artifact; no functional Java source was changed. Current APK SHA-256: `0d358d873b68b404a0cafe8bd7624b89c634e5a88679cbcbac02323eb44be5ea` (1,280,995 bytes). Complete notice text in the APK matches the separate download.

The desktop/mobile UI/export check was repeated once for the updated source templates and notice link: **6/6 groups passed**, with no external requests, writes, page errors or CSP violations. `python3 tests/verification-release-kit.py` independently confirmed all nine ZIP entries, eight manifest hashes, separately served file equality, APK-embedded notice equality and sandbox defaults. The localhost export ZIP is 1,266,969 bytes, SHA-256 `8d1824c2e059137404105f246daa2454cd49a7158d139579f0cd18c7484bda88`; production origins produce their own regenerated ZIP/checksum. API/authentication tests were not repeated for the notice-only packaging change.

## Reproduce the local read-only UI check

```sh
npm run build:independent -- --preview
npm run db:migrate:local -- --preview
npm run dev:cloudflare -- --preview
```

In another terminal, run `node tests/verification-independent-ui.mjs`. The test owns a temporary static server on port 5174 and expects the preview Worker on 8787. It does not configure a test identity or weaken production authentication. Override `PLAYWRIGHT_MODULE` and `CHROME_PATH` when using a different local browser installation.
