# Deploy Nabda to your own Cloudflare and Netlify accounts

The independent edition puts the public illustrated website on **Netlify** and the API, browser dashboard and account database on **Cloudflare Workers + D1**. GitHub verifies account sign-in. Android still owns its SQLite sending queue, message text, recipients and results.

This guide prepares a **new independent installation**. The existing hosted edition is not changed or disabled by building these files. No external account is connected, resource created or code published until you run the relevant account or deployment command yourself.

## What you need

- A Cloudflare account on the Free plan.
- A Netlify account on the Free plan.
- Your GitHub account, with a verified email address, to register the sign-in OAuth App.
- On the computer doing the build: Node.js **22.13+**, npm, Python 3 and Bash. macOS already has Bash; on Windows use Git Bash or WSL. Android Studio, Docker and a credit card are not prerequisites for this deployment path.

No password, hosting API token or GitHub Client Secret needs to be shared in a chat. Hosting CLIs sign in through your browser. The public Client ID is different from the private Client Secret.

## The guided setup

From this checkout:

```sh
cd /path/to/Nabda
npm ci
bash scripts/setup-hosting.sh
```

The six stages are:

1. Sign in to Cloudflare using Wrangler's browser authorization.
2. Sign in to Netlify, then link an existing project or create an empty one.
3. Select or create a **fresh** D1 database and record its UUID.
4. Record the public API and website origins and the Worker name.
5. Register your GitHub OAuth App and record its public Client ID.
6. Validate settings, build both outputs, and run a local deployment dry run.

The wizard opens the relevant pages and writes **public coordinates only** to ignored `.env.deploy`. It does not publish the application, apply remote migrations, copy an existing database or ask for an OAuth secret. It uses the checked-in Wrangler and Netlify CLI version `27.16.2`; the first Netlify command downloads that CLI through npm.

For manual setup, copy [.env.deploy.example](../.env.deploy.example) to `.env.deploy` and fill the same values with a text editor. Do not source this file as shell code. The build reads it as data.

## Account setup details

### Cloudflare

Open [Cloudflare Dashboard](https://dash.cloudflare.com/), choose the Free plan, then authorize the local Wrangler CLI:

```sh
node node_modules/wrangler/bin/wrangler.js login
```

In Workers & Pages, find or choose your account's `workers.dev` subdomain. With Worker name `nabda-api`, the API origin will be `https://nabda-api.YOUR_SUBDOMAIN.workers.dev`. Replace that example with your actual address; the build refuses placeholder addresses. You can later use your own domain if you already own one.

Create a new empty D1 database:

```sh
node node_modules/wrangler/bin/wrangler.js d1 create nabda-api
```

Copy the returned `database_id` into `NABDA_D1_DATABASE_ID`. Keep `NABDA_D1_DATABASE_NAME` equal to the database name you created. Using a fresh database avoids accidentally applying these migrations to another product. [Wrangler account authorization](https://developers.cloudflare.com/workers/wrangler/commands/), [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/).

### Netlify

Sign in and create an empty project, or link one that you own:

```sh
npx --yes netlify-cli@27.16.2 login
npx --yes netlify-cli@27.16.2 sites:create
# For an existing project, use `link` instead of `sites:create`.
```

The command links this checkout and prints a project URL. Put its `https://PROJECT.netlify.app` origin in `NABDA_WEBSITE_ORIGIN`. The local `.netlify` state is ignored by Git and is not copied to the public website. [Netlify CLI login](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/), [create/link projects](https://cli.netlify.com/commands/sites/).

### GitHub sign-in

Open [Register a new OAuth application](https://github.com/settings/applications/new). Under Settings → Developer settings → OAuth apps, enter:

| Field | Value |
| --- | --- |
| Application name | Nabda |
| Homepage URL | Your actual `NABDA_WEBSITE_ORIGIN` |
| Authorization callback URL | Your actual `NABDA_API_ORIGIN` followed by `/auth/github/callback` |

Copy the **Client ID** to `NABDA_GITHUB_CLIENT_ID`. Generate a **Client Secret** and keep it private; enter it only in the Cloudflare secret prompt below. This sign-in requests profile and email access, not repository access. State is bound to the initiating browser, S256 PKCE protects the authorization code, and each attempt can be redeemed once. [OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), [GitHub's OAuth flow and PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Nabda stores a stable GitHub user ID, display name and verified email in D1. The GitHub access token is used during sign-in and is not stored in D1 or returned to the browser. Nabda issues its own random, hashed-at-rest session token with a seven-day expiry in a host-only HttpOnly, Secure, SameSite=Lax cookie. Management calls cannot authenticate using application keys or caller-provided identity headers.

## Build and check without publishing

Once `.env.deploy` has real public coordinates:

```sh
npm run build:independent
npm run check:cloudflare
```

| Output | Purpose |
| --- | --- |
| `deploy-build/netlify/` | Only the public HTML, four illustrations, fonts, API reference and downloadable starter/APK |
| `deploy-build/cloudflare-assets/` | Browser dashboard and its public assets |
| `deploy-build/cloudflare-worker/` | Wrangler's dry-run API bundle |
| `wrangler.nabda.json` | Generated Cloudflare config using your actual D1 binding and origins |

The independent build does not import the Sites connector, Vinext or ChatGPT authentication into the API bundle. The old hosting files remain in source to keep the existing deployment working during the move. They are not used by the independent entry point `worker/cloudflare.ts`.

The Netlify export updates canonical URLs, API examples, dashboard links, privacy copy, OpenAPI authentication and the starter README. It rebuilds the ZIP and checksum manifest from an explicit public-file allowlist. Secrets, database state, account exports and local hosting credentials are never included. The existing Android APK is unchanged because its API origin comes from the pairing QR or manual entry.

For an **account-free local preview** only:

```sh
npm run build:independent -- --preview
npm run db:migrate:local -- --preview
npm run dev:cloudflare -- --preview
```

This uses `http://127.0.0.1:8787` for the API and `http://127.0.0.1:5174` for website links. In a second terminal at the project root, preview the page with:

```sh
python3 -m http.server 5174 --bind 127.0.0.1 --directory deploy-build/netlify
```

That simple server previews content; it does not emulate Netlify's headers or redirects. GitHub sign-in remains unavailable without real OAuth configuration; there is no fake production login. Preview flags cannot deploy or modify remote resources. Rebuild **without** `--preview` before any real upload.

## Publish the independent API

After reviewing the real addresses and selecting the fresh D1 database:

```sh
npm run db:migrate:remote
npm run deploy:cloudflare
npm run secret:cloudflare
```

The first command applies the checked-in migrations, including the separate user/session/OAuth tables. The second publishes your Worker and dashboard. The last command asks for `GITHUB_CLIENT_SECRET` privately and stores it as a Cloudflare Worker secret. It is not a command argument, public environment variable or Netlify build setting. Until the secret is set, sign-in fails closed. [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Keep the Client ID in `.env.deploy` and the Client Secret in Cloudflare. For optional local OAuth development, use a separately registered local OAuth App: put its public ID in `NABDA_PREVIEW_GITHUB_CLIENT_ID`, copy `.dev.vars.example` to ignored `.dev.vars` for its local secret, and register the loopback callback. Preview always uses loopback origins and a separate dummy database identity, even when production coordinates are saved. Local secrets are not uploaded automatically. Do not use a production D1 database for local protocol testing.

## Publish the static website

From the linked project root, upload a draft first:

```sh
npm run build:netlify
npx --yes netlify-cli@27.16.2 deploy --no-build --site=YOUR_EXISTING_SITE_NAME --dir="$PWD/deploy-build/netlify"
```

Review the draft, then publish the same export:

```sh
npx --yes netlify-cli@27.16.2 deploy --prod --no-build --site=YOUR_EXISTING_SITE_NAME --dir="$PWD/deploy-build/netlify"
```

Replace `YOUR_EXISTING_SITE_NAME` with the name of the project you already created or linked. Use `--no-build` because the static export was built in the first command; the deploy must upload that reviewed export without selecting another framework or running a second build. The absolute directory makes the export location unambiguous even with the configured Netlify base directory. In our deployment with CLI 27.16.2, using the existing project's name succeeded when its UUID produced “Project not found”; using the name is the verified workaround for that environment.

Alternatively upload the **contents of `deploy-build/netlify`** to your project using Netlify's manual deploy interface. Do not upload the checkout, `.env.deploy`, `.dev.vars`, the Cloudflare bundle or the preview-only export. [Manual deployment](https://cli.netlify.com/commands/deploy/).

To preserve Nabda's uncluttered page, turn off **Project configuration → General → Powered by Netlify badge**. This optional setting is available on Free plans, applies on the next request, and does not require a redeploy or plan upgrade. The live Nabda project has the badge and pre-launch toolbar disabled. Netlify still adds a hosting-only HTML comment at its edge; that does not change the visible page or load a script. [Netlify badge settings](https://docs.netlify.com/manage/projects/powered-by-netlify-badge/).

For Git-based Netlify builds, the checked-in `netlify.toml` uses a small standalone `deployment/netlify` base so the old Next/Vinext project is not selected as the website runtime. Set only these public build environment variables in Netlify:

```text
NABDA_API_ORIGIN=https://YOUR_REAL_API_ORIGIN
NABDA_WEBSITE_ORIGIN=https://YOUR_REAL_WEBSITE_ORIGIN
```

The build command is `node ../../scripts/build-netlify.mjs`; publish directory is `../../deploy-build/netlify`, relative to that base. Node 22 and Python 3.13 are selected by the configuration. Neither the GitHub Client Secret nor D1 credentials belong in Netlify. [Build configuration](https://docs.netlify.com/build/configure-builds/overview/), [available build tools](https://docs.netlify.com/build/configure-builds/available-software-at-build-time/).

## Check the move before switching users

1. Open your API's `/health`; it should report `status: ok`, `mode: phone-owned`. This tests liveness only.
2. Open `/dashboard` on the API origin. Sign in with GitHub and verify your email address if asked. Confirm that sign-out returns to the signed-out view and old sessions cannot access `/api/account`.
3. Create a new application key and pairing QR. The QR must contain your **Cloudflare API origin**, not the Netlify website.
4. Scan it with Nabda Android. Keep **Connect in test mode** selected and start the phone service.
5. Set `NABDA_BASE_URL` to the API origin and use the downloaded client to submit a single sandbox request. Check status, idempotent replay and cancellation. Do not use a real SMS to verify hosting.
6. Confirm the public website, four transparent illustrations, downloads and optional collapsed support details work at the Netlify address.

The existing Sites user identity is different from the new GitHub identity. This preparation does **not** migrate previous cloud users, keys, device credentials or pending commands. Create fresh keys and re-pair after reviewing received work on the phone. Preserve its queue/history and do not recreate an old send merely because a new server has no status for it. A data migration, if required, needs a separate authorized export and stable owner mapping.

Keep the old service available until the new sign-in and sandbox checks succeed. Real GitHub authorization, account provisioning, public deployment and physical-phone pairing cannot be proven by the local mocked tests alone.

## Free-plan capacity

Workers Free currently includes 100,000 requests/day and 10 ms CPU per request. D1 has separate read/write/storage limits. Netlify Free includes 300 monthly credits. These are account-wide hosting allowances, not SMS quantities or a promise of unlimited public use. At the current 60-second idle interval, one continuously connected phone makes about 1,440 polls/day before messages and results. See [the hosting comparison](hosting-options.md) for the verified limits and primary sources.
