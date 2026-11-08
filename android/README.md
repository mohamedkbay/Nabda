# نبضة Android 0.2.0

A small native Java Android gateway. The phone owns its SQLite message queue, original text, recipients, journal, individual SMS-part results and history. Cloud commands are staged locally until the server explicitly acknowledges handoff. Pair through the bundled QR scanner, `nabda://pair` link or manual HTTPS origin and one-time pairing token.

## Build

Requires JDK 17+, Android SDK 36 and access to Google's/Maven repositories. The Gradle 9.4.1 wrapper and Android Gradle Plugin 9.2.1 configuration are included. Set `ANDROID_HOME` to your SDK path, then run from this directory:

```
./gradlew :app:assembleDebug
```

The supplied `artifacts/Nabda-Android-0.2.0.apk` is a **debug-signed test build**. A production signing key and signed release update process have not been provisioned. Do not describe it as a Play Store-approved release. Run `./gradlew :app:testDebugUnitTest :app:lintDebug` for the local SQLite protocol tests and Android lint. Tests use Robolectric and do not call the modem.

## Use

1. Install APK and open نبضة. Generate a pairing QR in the site dashboard.
2. Scan it (camera permission is optional) or paste site address and full pairing token. Tap Pair this phone.
3. Choose a SIM after granting SMS/phone permissions. Android permission restrictions and installer eligibility still apply.
4. Start **test mode** to connect and exercise sandbox requests without sending SMS. Non-sandbox jobs stay waiting.
5. Only when ready, stop test mode and explicitly tap **Start phone sending**. This submits real carrier SMS for eligible live jobs. SMS costs are charged by the SIM carrier.

Stop prevents new submissions, but cannot recall a message already handed to the modem. Pause does not delete local messages. Queue/history can be reviewed locally; the last 100 rows are shown while counts query the full local database. The optional support page opens in the browser; payment has no influence on sending access.

## Try the free hosted edition

The current site is https://nabda-phone-api.mohamed-kbay.chatgpt.site. Download the APK from its installation section or directly at `/downloads/Nabda-Android-0.2.0.apk`. Android 8.0 or newer is required. You do not need Android Studio, a computer on the same Wi-Fi network, an external SMS gateway subscription, or paid push credentials to use this build. The phone needs internet access to the HTTPS site. Real SMS uses your own SIM and its carrier charges; free platform allowances still apply.

Sign in to the account dashboard and create a fresh pairing code. Scan it in the app, or enter the site origin above and the complete one-time pairing token manually, then tap **Pair this phone**. The pairing token is not your application's API key. Codes last ten minutes and work once; create another if one expires or has already been used. Camera access is optional. Stop an existing connection before pairing with another account or site.

For the first trial, tap **Connect in test mode**, create an application API key in the dashboard, and make a message request with `sandbox: true` and that phone's device ID. Test mode does not require a sending SIM or SMS permission and never calls the SMS transport. Sandbox results are simulated, including `delivered`; they do not prove carrier delivery. Leave the app's connection running and allow roughly one idle polling interval (at least 60 seconds), plus request and event synchronization time. The API's `sandbox` field distinguishes the result. Stop test mode before selecting a SIM and deliberately starting real phone sending.

The downloadable APK is 1,280,995 bytes. Its SHA-256 is:

```text
0d358d873b68b404a0cafe8bd7624b89c634e5a88679cbcbac02323eb44be5ea
```

The original build artifact, public download, and hosted download were checked against this hash. The APK ZIP structure and Android signature verified. The signer is `CN=Android Debug, O=Android, C=US`, with certificate SHA-256 `5b7034f1c974e27bdbfee76ffc770261ed8ff226e7af1af93f9dbfd7036c7f8f`. This remains a debug-signed trial build; production signing and a trusted release-update process have not been provisioned.

## Reliability and privacy

- HTTPS origins only; HTTP redirects are rejected before forwarding credentials. Tokens are encrypted with an Android Keystore AES-GCM key; application backups are disabled.
- The foreground `remoteMessaging` service starts only after a visible user action; it is not silently restarted after Force Stop. Idle polling is at least 60 seconds, with bounded offline backoff. No FCM credentials or paid push service are required for this build. Arrival is therefore not instantaneous.
- Each local command is unique. Only IDs acknowledged by the API release a staged send to the local queue. An ACK response lost in transit can be retried. Queue processing continues offline only after approved handoff.
- One active submission at a time, explicit active subscription, no silent default-SIM fallback, configurable pacing per SMS part, and an additional wait after Android limit errors. No OS-limit bypasses.
- A durable attempt is written before calling SmsManager. Restarted/interrupted attempts become `outcome_unknown`; they are not blindly resent. Late part callbacks may resolve uncertainty. Event uploads are retried with the same event IDs.
- Local blocklist is checked immediately before dispatch. This app does not request contacts or incoming SMS access, and does not upload an entire phone address book or inbox.
- Caller identity, app API keys and device tokens are separate. Local records remain associated with their original HTTPS origin plus pairing device ID when switching accounts/sites; old events are not uploaded to the new account.

## Known verification limits

The first build completed `assembleDebug` and `lintDebug` (non-blocking compatibility/i18n warnings remain), 10 Robolectric SQLite protocol tests, and 21 pure JVM origin/phone policy assertions. The SQLite cases cover durable ACK release, repeated commands, rejected handoff, cancellation races, uncertain recovery, late per-part callbacks, device isolation, sandbox gating and future-schedule starvation. No real SMS was sent during development. Carrier behavior, receipt availability, runtime permission grants, force-stop behavior and long-running endurance need controlled tests on supported physical devices. Not every OEM permits the same background behavior. Receiving all part callbacks does not prove a person read the message. Device reports are not independent carrier attestations.
