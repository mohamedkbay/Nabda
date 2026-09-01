# Nabda Desktop migration

Status: phase-one local application

## Decision

Nabda Desktop is the primary installed experience. It runs Electron and TypeScript in one local process boundary, uses SQLite as its durable store, and runs a small database-backed queue worker. The installed application does not require Docker, PostgreSQL, Redis, or the hosted API.

The existing Fastify/PostgreSQL/Redis server remains a separate deployment option. Desktop does not silently connect to, migrate, or reuse that server database.

## Local data boundary

- Database: `<Electron userData>/nabda.sqlite3`
- Database mode: WAL, foreign keys enabled, versioned migrations
- Secrets: Electron `safeStorage`, main process only
- Backups: validated SQLite snapshot and non-secret metadata; provider secrets are excluded
- Import: validate first, then replace atomically; keep the previous database if validation fails
- Renderer: no Node.js access, no generic IPC bridge, no network access

Uninstalling the program does not automatically delete user data. This protects contacts and message history from an accidental uninstall. A user can remove that directory manually only after exporting a backup and closing the application.

## Queue and delivery safety

The queue lives in SQLite and survives restarts. Opt-outs are checked when a message enters the queue and again immediately before the provider adapter runs. The default and only enabled phase-one provider is Mock; its connection test and worker never open an SMS transport.

## Phone pairing

Desktop listens on one selected private IPv4 address and a fixed local port. It does not bind the pairing endpoint to all interfaces. The one-time 32-byte Base64URL code is stored as SHA-256 with a scope prefix, expires in five minutes, and is single-use.

The QR contract is:

```text
nabda://pair?v=1&endpoint=http%3A%2F%2F<PRIVATE_LAN_IP>%3A<PORT>&code=<ONE_TIME_CODE>&desktop=<SHORT_DESKTOP_ID>
```

After claim, Desktop returns a permanent scoped device token exactly once and stores only its hash. Heartbeat authentication uses that token. Revoking a device invalidates its token; rotating creates a new token and invalidates the previous value.

On Windows, permit Nabda Desktop through Windows Defender Firewall only when the network profile is **Private**. Do not expose the pairing port through a router, port-forward, public Wi-Fi, VPN gateway, or cloud tunnel.

## Deferred work

- Authenticated local TLS or an equivalent mutually authenticated local channel
- Signed Windows installer and publisher identity
- A reviewed, explicitly enabled live-SMS transport
- Server-to-Desktop migration/import tools

These deferrals are intentional. Phase one is for local product, maintenance, UX, and Simulation testing; it must not send carrier SMS.
