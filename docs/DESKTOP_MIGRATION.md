# httpSMS Desktop migration

Status: phase-one local application

## Decision

httpSMS Desktop is the primary installed experience and is clearly presented as an unofficial client. It runs Electron and TypeScript in one local process boundary, uses SQLite as its durable store, and runs a small database-backed queue worker. The installed application does not require Docker, PostgreSQL, Redis, or the legacy hosted API.

The existing Fastify/PostgreSQL/Redis server remains a separate deployment option. Desktop does not silently connect to, migrate, or reuse that server database.

## Local data boundary

- Database: `<Electron userData>/httpsms-desktop.sqlite3`
- Database mode: WAL, foreign keys enabled, versioned migrations
- Secrets: Electron `safeStorage`, main process only
- Backups: validated SQLite snapshot and non-secret metadata; provider secrets are excluded
- Import: validate first, then replace atomically; keep the previous database if validation fails
- Renderer: no Node.js access, no generic IPC bridge, no network access

Uninstalling the program does not automatically delete user data. This protects contacts and message history from an accidental uninstall. A user can remove that directory manually only after exporting a backup and closing the application.

## Queue and delivery safety

The queue lives in SQLite and survives restarts. Opt-outs are checked when a message enters the queue and again immediately before the provider adapter runs. Test fixtures use a mocked network boundary, and **Test connection** reads provider account metadata only; neither operation sends an SMS. A deliberately queued message can call the configured provider and may therefore use the phone's SIM.

Ambiguous provider outcomes are not retried blindly. They move to manual review. Messages with provider IDs are reconciled by bounded status polling at the configured interval.

## Official Android application and provider setup

httpSMS Desktop does not build, bundle, or brand an Android application. The operator installs the official httpSMS Android application from the provider's documentation and signs in according to the provider's instructions.

Desktop Settings accepts two provider values:

- **Account API key:** the full key from provider account settings, not a phone-only API key. The main process encrypts it with Electron `safeStorage`; it is excluded from SQLite, renderer IPC responses, backups, and logs.
- **From:** the phone number registered to the official Android application, normalized to E.164.

The local worker submits a queued message to the hosted provider API. The official Android application obtains work through its provider-managed connection, and Desktop polls the hosted API for later message status. httpSMS Desktop does not expose a phone endpoint on the LAN and requires no custom APK, QR pairing code, local device token, ADB tunnel, certificate installation, port-forward, or Windows Firewall exception.

httpSMS is a third-party product and trademark of its respective owner. This repository contains an independent, unofficial desktop client and must not present itself as the provider or its official Android application.

## Deferred work

- Signed Windows installer and publisher identity
- Provider-account onboarding and credential-rotation UX review
- Optional provider webhook ingestion; status polling remains the current Desktop reconciliation path
- Server-to-Desktop migration/import tools

These deferrals are intentional. Development tests and connection checks must not send carrier SMS. A real queued send is an explicit operator action and remains subject to provider, carrier, consent, legal, and operational controls.
