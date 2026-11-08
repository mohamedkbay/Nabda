# Contributing to Nabda

Bug reports, documentation improvements and focused pull requests are welcome. For a substantial change, open an issue first so we can agree on the behavior and scope.

## Local workflow

Use Node.js 22.13+, npm and Python 3. Start with [the README](README.md) and the account-free preview. Do not use a real sending phone for development tests.

Before opening a pull request:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check:cloudflare -- --preview
```

Add a focused test when behavior changes. Describe the problem, resulting behavior and verification in the pull request. Screenshots help when a visible interface changes. Keep generated output, credentials, phone numbers, message text, local databases and account exports out of commits and reports.

## Design constraints

- Android owns the durable sending queue and message details. Cloud commands hold recipient/text only until approved handoff.
- Preserve tenant isolation, credential separation, idempotency, sandbox behavior and cancellation semantics.
- Never automatically repeat a modem submission with an unknown outcome.
- Browser identity must come from a verified session. Incoming identity headers are not authentication.
- Keep website text in plain English and preserve the single-page illustrated design. The dashboard is a separate utility.
- Do not add a carrier call, automatic deployment or paid dependency to the test workflow.

Change `db/schema.ts` and generate a new migration for schema changes. Do not rewrite migrations that may already be applied. Include a migration note when existing installations need an extra step.

The independent runtime starts at `worker/cloudflare.ts`. Files explicitly marked as legacy support the previous hosting adapter during migration and are not used by the independent API. New work should target the independent build.

## Reporting bugs

Use [GitHub issues](https://github.com/mohamedkbay/Nabda/issues). Include the app version, platform, steps to reproduce, expected behavior and a redacted error. Use invented recipients and message contents in examples.

Security reports belong in [the private reporting process](SECURITY.md), not a public issue. Contributions are accepted under the project's MIT license; retain all applicable third-party notices.
