# httpSMS Desktop

An **unofficial desktop client** for the third-party [httpSMS](https://httpsms.com/) service. It provides a local Windows workspace for customers, contacts, opt-outs, campaigns, queued messages, status history, settings, and backups.

This project is independent. It is not the official httpSMS Android application, is not affiliated with or endorsed by its publisher, and does not claim ownership of the httpSMS name or brand.

## How it works

```text
httpSMS Desktop
├── Electron renderer (isolated, no Node.js)
├── Electron main process
│   ├── SQLite database in the OS user-data directory
│   ├── OS-encrypted Account API Key via safeStorage
│   └── local queue and bounded status polling
└── HTTPS → official httpSMS API → official Android app → user's SIM
```

The installed application does not require Docker, PostgreSQL, Redis, Java, an Android SDK, a LAN listener, QR pairing, or a custom phone backend. The legacy server code under `src/` is not included in the Electron package.

## Phone and provider setup

1. Create or sign in to your httpSMS account.
2. Install the official Android application by following the [httpSMS getting-started guide](https://docs.httpsms.com/).
3. Sign in to the official application and keep the phone online with the permissions documented by the provider.
4. In httpSMS Desktop, open **Integration**.
5. Enter the full **Account API Key** from provider settings. Do not use a phone-only API key here.
6. Enter **From** as the registered phone number in E.164 format, for example `+2189XXXXXXXX`.
7. Save, then choose **Test Connection**.

Test Connection reads provider account metadata only. It does not call the message-send endpoint and does not send an SMS.

The Account API Key is encrypted by Electron `safeStorage` in the main process. It is never written to SQLite, renderer storage, backups, logs, or QR codes. The non-secret `From` value and polling interval are stored in SQLite.

## Local data

The application stores its database under Electron's `app.getPath("userData")` directory:

- Windows: normally `%APPDATA%\httpSMS Desktop (Unofficial)\httpsms-desktop.sqlite3`
- macOS development builds: normally `~/Library/Application Support/httpSMS Desktop (Unofficial)/httpsms-desktop.sqlite3`

SQLite uses foreign keys, WAL mode, and ordered migrations. Uninstalling the program does not delete user data automatically.

Backups contain the validated SQLite data and intentionally exclude the provider API key. Import validates the backup before replacing the active database and preserves the existing database if validation fails.

## Message safety

- Only expected messages to recipients who agreed to receive them are permitted.
- Opt-outs are checked when a message enters the queue and again immediately before provider submission.
- A deliberately queued message can result in a real carrier SMS and may consume provider allowance or SIM credit.
- Ambiguous provider outcomes are not retried automatically; they require manual review.
- Desktop polls the provider for later delivery status at the configured interval.
- Unit tests use mocked network boundaries and do not send SMS.

## Developer quick start

Requirements: Node.js 24 LTS and npm.

```bash
npm ci
npm run test:desktop
npm run dev:desktop
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run check` | Type-check all TypeScript without emitting files |
| `npm run test:desktop` | Run the explicit Desktop test set |
| `npm run build:desktop` | Compile Electron main/preload code and copy renderer assets |
| `npm run dev:desktop` | Build and open the application locally |
| `npm run dist:dir` | Create an unpacked application for the current OS |
| `npm run dist:win` | Test, build, and package the Windows x64 NSIS installer |

## Windows installer

Run on Windows 10/11 x64:

```bash
npm ci
npm run dist:win
```

The installer is written to:

```text
release/httpSMS-Desktop-Unofficial-<version>-Setup-x64.exe
```

The workflow `.github/workflows/windows-desktop.yml` performs a locked install, runs the Desktop tests, and uploads the EXE as a private build artifact. It does not deploy or publish the application.

The NSIS installer creates Start Menu and desktop shortcuts, supports choosing the installation directory, and leaves local user data in place during uninstall to reduce accidental data loss.

## Security boundary

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandbox enabled
- named and validated IPC only; no generic IPC escape hatch
- navigation and untrusted window creation denied
- provider key owned by the main process and protected with OS encryption
- no credential in logs, SQLite, backups, command-line arguments, or renderer responses
- official provider HTTPS endpoint only
- no local HTTP phone server or public inbound port

## Project structure

```text
desktop/             Electron main, preload, renderer, SQLite, queue, provider adapter
tests/               Desktop core, backup/migration, and shell-security tests
scripts/             Desktop asset and website build helpers
build/               Local installer icon
docs/                Architecture and migration notes
src/ migrations/     Legacy server package, excluded from the Desktop installer
public/               Separate informational website
```

## Provider and legal responsibility

httpSMS is a third-party service and trademark of its respective owner. Its application, API availability, account limits, pricing, permissions, and terms are controlled by the provider and may change independently of this project.

The operator is responsible for account security, the phone and SIM, provider and carrier charges, recipient expectations, consent evidence, opt-out handling, message content, staff access, and applicable law. This educational project is not a telecommunications service or legal advice.
