# Public repository preparation

Reviewed **2026-11-08**. This is a publication audit of the current independent edition and the existing `mohamedkbay/Nabda` repository. It does not claim that Cloudflare/Netlify have been provisioned, that a real OAuth login has completed, or that carrier delivery has been tested.

## Repository state

- GitHub repository: [mohamedkbay/Nabda](https://github.com/mohamedkbay/Nabda), already public, default branch `main`.
- Reviewed remote head: `2a15b4e41c052bbff32196e7a1cb4e2da27abfd6` (16 commits). Its current tree contains the older Fastify/PostgreSQL/Redis and Windows Controller edition, not this phone-owned Cloudflare edition.
- The remote had no root license or repository description at review time. Its homepage still referenced the previous Vercel deployment.
- The local checkout has a separate five-commit Sites history and no configured Git remote. Do not push that unrelated history over the existing GitHub `main`.

## Preserve history when publishing

1. Start from a clean checkout of the existing GitHub `main`.
2. Apply a reviewed independent-source snapshot as a normal new commit. The old edition remains available in previous commits; no force-push or history rewrite is needed.
3. Exclude local credentials, hosting state, personal data, caches and generated intermediate builds. Stage the intended source files explicitly.
4. Replace old architecture and deployment instructions with the current API-service README; add the project's chosen open-source license and retain all applicable third-party notices.
5. Check the remote head again before pushing. If it advanced, incorporate its changes deliberately instead of overwriting them.
6. Update the repository description, topics and homepage to reflect the actual deployment state. A prepared hostname is not a live service.

## Data and credential review

The current tracked local tree had **211 files**. A bounded read-only scan of **214 reachable local text blobs** and **437 reachable text blobs** in the existing GitHub history found no high-confidence private-key, GitHub token, AWS access-ID, provider-key or concrete Nabda-token pattern. Generic secret-assignment patterns also match configuration expressions, documentation and tests; this scan is not proof that every possible credential format is absent.

No tracked or historical CSV/XLSX/VCF/contact database files were found in either reviewed history. Android build metadata contained no absolute local paths or runtime credentials. The compiled APK remains a development artifact, not an account export.

Always exclude `.env`/`.dev.vars` with real values, `.netlify/`, `.wrangler/`, `node_modules/`, `work/`, `outputs/`, generated deployment configuration, Android tool caches and local databases. Keep only clearly marked example configuration files.

The tracked `.openai/hosting.json` contains a creator-specific project identifier, not a secret credential. It is not reusable independent deployment configuration. Omit that owner-specific binding from the public independent snapshot or replace it with a generic opt-in legacy template, ensuring the independently documented build still works from a fresh clone. Retain any legacy scaffolding only if its purpose and dependencies are explicit.

## Licenses and artifacts

- A public GitHub repository without a license does not itself grant an open-source reuse license. Apply the selected license to Nabda-authored code; do not replace dependency licenses with it.
- Preserve `public/fonts/Cairo-OFL.txt`, `public/fonts/Caveat-OFL.txt` and `vendor/shadcn-tailwind-4.13.0.LICENSE.md` when distributing their associated files.
- If legacy Sites tooling remains, preserve `scripts/vite/sites-vite-plugin.LICENSE`, including its upstream MIT attribution.
- Android resolves `com.journeyapps:zxing-android-embedded:4.3.0` and `com.google.zxing:core:3.4.1`. The upstream tagged Apache license/attribution texts are reproduced in `android/app/src/main/assets/third-party-notices.txt` and the identical `public/downloads/THIRD-PARTY-NOTICES.txt`. Sources: [JourneyApps COPYING](https://github.com/journeyapps/zxing-android-embedded/blob/v4.3.0/COPYING), [JourneyApps attribution](https://github.com/journeyapps/zxing-android-embedded/blob/v4.3.0/README.md#license), [ZXing LICENSE](https://github.com/zxing/zxing/blob/zxing-3.4.1/LICENSE), [ZXing NOTICE](https://github.com/zxing/zxing/blob/zxing-3.4.1/NOTICE), [ZXing AUTHORS](https://github.com/zxing/zxing/blob/zxing-3.4.1/AUTHORS).
- Keep the included APK labelled **debug-signed test build**. Production signing, Play Store distribution and physical carrier testing are separate work.
- After any APK or notice packaging change, regenerate the starter archive and every published checksum, and verify that the archive matches the separately downloadable files.

Before switching users, complete the real-provider sign-in and phone sandbox checks in [DEPLOYMENT.md](DEPLOYMENT.md). This audit made no GitHub changes, sent no messages, and created no external hosting resources.
