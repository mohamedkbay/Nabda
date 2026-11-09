# Project check — 2026-11-09

The initial review below is followed by the completed maintenance results at the
end of this document. Its pre-maintenance dependency findings are historical.

The hosted API responded correctly to public read-only checks. Local protocol,
authentication, deployment and starter-client tests passed. Physical Android
handoff and carrier SMS delivery were not tested. No production writes, deployment,
package upgrades or SMS were performed during this review.

## Hosted checks

| Request | Result |
| --- | --- |
| `https://nabda-api.mohamed-kbay.workers.dev/health` | 200; `status: ok`, `mode: phone-owned`, version `0.2.0` |
| API `/dashboard` | 200 HTML |
| Anonymous API `/api/account` | 401 `sign_in_required` |
| Anonymous API `/v1/usage` | 401 `invalid_token` |
| `https://nabda-phone-api.netlify.app/` | 200 HTML |
| Website `/openapi.json` | 200; server URL matches the Cloudflare API origin |

These checks establish public availability and anonymous access rejection. Health
does not inspect D1, a phone or its SIM. Authenticated hosted message submission
and the real GitHub sign-in flow were not repeated in this review.

## Local verification and changes

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed after the changes below |
| API protocol suite | 26 checks passed with isolated Miniflare D1 |
| Concurrent application-key cap | Passed |
| Independent authentication suite | 11 groups passed; simulated GitHub responses |
| Deployment configuration suite | 8 checks passed |
| Node/Python/Postman starter suite | 22 checks passed; localhost mocks only |
| `npm run build` | Passed; independent localhost exports |
| `npm run check:cloudflare -- --preview` | Passed; dry-run only |
| Local preview migrations | Already up to date |
| `node tests/verification-independent-ui.mjs` | 6 groups passed on desktop/mobile; no page errors, CSP violations, writes or external requests |
| `git diff --check` | Passed |

Dashboard time state now initializes lazily. Account/history loaders use stable
callbacks, and polling effects declare their dependencies. The existing native
links and images are explicitly supported by ESLint for shared Nabda components,
which also run without a Next router or image service in the independent Vite
dashboard. Generated `deploy-build/` output is excluded from source linting.
An unescaped apostrophe and two unused-expression warnings were corrected.

The default `npm test` now includes the existing starter-client/Postman checks.
CI also runs lint. The Postman collection itself required no changes. Existing
uncommitted project work was preserved; nothing was committed or pushed.

## Dependency findings before maintenance

`npm outdated` reported newer versions for 35 direct dependencies. `npm audit`
reported **34 affected dependency entries: 1 critical, 15 high, 17 moderate and
1 low**. Transitive entries can share the same underlying advisory; this is not
a count of independently exploitable application defects.

| Priority package | Installed | Available target reported by npm | Review needed |
| --- | --- | --- | --- |
| `next` | 16.3.4 | 16.4.5 | Critical advisories; update before using the legacy Next runtime |
| `vite` | 8.0.13 | 8.3.7 | Development-server advisories; verify both build paths |
| `wrangler` | 4.92.0 | 4.158.0 | Update together with compatible Miniflare/Cloudflare tooling |
| `@cloudflare/vite-plugin` | 1.37.1 | 1.67.0 | Toolchain/transitive advisories |
| `react-server-dom-webpack` | 19.2.6 | 19.3.1 | Keep aligned with the React and legacy framework versions |
| `vinext` | 1.0.0-beta.5 | 1.4.4 | Legacy adapter and transitive advisories |
| `zod` | 3.25.76 | 4.6.7 | Major-version migration; audit proposes version 4 |

The generated independent Worker source map contains only `lib/nabda-api.ts`,
`lib/independent-auth.ts` and `worker/cloudflare.ts`. None imports Next, Zod or
the legacy adapter. This supports the inference that their server-side advisories
do not describe code bundled into this locally built independent Worker; it is
not proof that every deployment or development tool is unaffected. The static
website and client dashboard do not run a Next server.

The [Next critical advisory](https://github.com/advisories/GHSA-673q-mjm6-r5xr),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and
[Vite advisory](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) were checked
against their published affected ranges. Package versions were left unchanged:
the update work needs compatibility validation, and npm's proposed fixes include
major upgrades and unrelated downgrades. Do not apply `npm audit fix --force`
blindly.

Full npm reports are retained locally under ignored
`outputs/qa/project-check-2026-11-09/`. Browser/export evidence is under ignored
`outputs/qa/independent/`.

## Completed maintenance follow-up

The affected runtime and development dependencies have been updated. The final
`npm audit` reports **0 vulnerabilities**, down from 34. The full dependency tree,
including development dependencies, was audited; package versions and integrity
hashes are recorded in `package-lock.json`.

- Next and its ESLint configuration: `16.4.5`; React, React DOM and React Server
  DOM: `19.3.1`; Zod: `4.6.7`.
- Vite: `8.3.7`; Vinext: `1.4.4`; Wrangler: `4.158.0`; Cloudflare Vite plugin:
  `1.67.0`; Workers types: `5.20261109.1`.
- Drizzle ORM/Kit and React/RSC plugins were updated to compatible versions.
  Miniflare and esbuild are now explicit development dependencies instead of
  tests relying on their transitive installation location.
- The old `sharp: 0.35.4` override was removed so the updated Miniflare can use
  its patched dependency. Narrow overrides select patched esbuild for the old
  esbuild-kit loader, minimatch for TypeScript ESLint, and fflate for legacy
  image-rendering dependencies. Other compatible transitive fixes were applied
  with `npm audit fix`, without `--force`.

Zod 4 record schemas now supply both key and value schemas. A regression check
exercises populated/empty records, invalid inputs, scope restrictions, limits and
driver messages. Miniflare tests use its official `convertV4MiniflareOptions`
adapter to retain the existing isolated Worker fixtures with the new runtime.

Verification after the dependency changes:

- A fresh clone of the existing GitHub `main` received the reviewed source;
  normal `npm ci`, TypeScript, lint, the entire `npm test` command and the
  independent build passed there without local deployment configuration.
- The retained legacy build passed after the transitive fixes.
- Drizzle generated the expected 11-table schema into ignored QA output. The
  checked-in migrations and production database were not changed.
- The desktop/mobile independent UI suite passed all six groups with the
  updated dashboard and Cloudflare runtime. It reported no page errors, CSP
  violations, writes or external requests.
- CI now includes source lint, starter clients, the connector regression check
  and `npm audit --audit-level=high` alongside its existing protocol/build checks.

The final machine-readable audit is retained locally at
`outputs/qa/project-check-2026-11-09/npm-audit-after.json`. This maintenance does
not establish physical Android or carrier delivery; no real SMS was sent.
