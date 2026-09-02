# Nabda Controller for Windows

Status: phase-one local controller

## Product decision

Nabda Controller is a background Windows application. Electron supplies packaging, the tray icon, single-instance behavior, Start-with-Windows support, and safe opening in the system browser. It does not create an Electron browser window.

The installed controller uses Node's built-in SQLite support and does not require Docker, PostgreSQL, Redis, or an external SMS provider. The Fastify/PostgreSQL/Redis application remains the multi-tenant server deployment option.

## Runtime layout

```text
Chrome / Edge on Windows
        │ loopback session cookie
        ▼
Nabda Controller :3210 ── SQLite queue
        ▲
        │ authenticated /v1/device/* on private LAN
        │ one message per claim
Android phone + company SIM
```

- Database: `<Electron userData>/nabda-controller.sqlite3`
- Browser address: `http://127.0.0.1:3210`
- Phone address: `http://<private-ip>:3210`
- Default live state: locked
- Monthly limit: 5,000 accepted messages
- Dispatch spacing: six seconds, or at most 10 per minute
- Active phone: one; completing a new QR pairing revokes the previous phone

## Browser boundary

The tray opens a URL carrying an unpredictable one-process bootstrap secret. Direct navigation to `http://127.0.0.1:3210` is also accepted only from the same computer and only with an exact loopback Host header. The controller creates an HttpOnly, SameSite=Strict session cookie and immediately redirects to a clean URL. Dashboard and control routes reject non-loopback clients. Mutations also require a custom control header, and the page is served with a strict CSP and frame denial.

The dashboard can manage contacts, CSV/TXT/VCF imports, opt-outs, individual messages, controlled contact campaigns, QR pairing, and the live-sending lock. The contact importer recognizes the reference `Name,Emails,PhoneNumbers` export and separates multiple semicolon-delimited phone numbers.

## Phone boundary

The dashboard creates a 256-bit pairing secret that expires after two minutes. Its QR contains the private-LAN controller address and that one-time secret—not the permanent device credential. Android validates the versioned `nabda://pair` payload, exchanges it once on the private network, and encrypts the returned bearer token with Android Keystore. The controller stores only a SHA-256 scope-bound hash. A completed new pairing revokes the previous phone.

On Dual-SIM Android phones, the agent lists active subscriptions by physical slot and carrier. The operator must select the sending SIM before the live agent starts. The encrypted selection is locked while connected and revalidated immediately before every carrier dispatch; a missing or inactive selection fails closed without falling back to the other SIM.

Claim reserves one queued message with a short hashed lease. Begin rechecks the live lock, opt-out state, queue state, lease, attempt ID, and the six-second dispatch fence. An event is accepted only for the bound phone and attempt. Event IDs are deduplicated; a changed replay is rejected. An authorized attempt that expires without a result is marked for manual review and is not blindly retried.

## Windows operation

- The app holds a single-instance lock.
- Closing the browser does not stop the controller.
- Clicking the tray icon opens a fresh authenticated dashboard session.
- The tray can enable Start with Windows.
- The tray can lock carrier sending immediately.
- Quit closes the HTTP listener and SQLite cleanly.

Windows Defender Firewall should allow Nabda only on a **Private** network. Do not port-forward TCP 3210 or expose it through public Wi-Fi, a public tunnel, or a router.

## Packaging

`npm run dist:win` runs the desktop tests, builds only the controller runtime, and creates an NSIS x64 installer named `Nabda-Controller-<version>-Setup-x64.exe`. The GitHub workflow uploads it as an artifact. The current installer is unsigned and intended for internal testing; public distribution requires a publisher certificate and signing pipeline.
