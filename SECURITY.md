# Security policy

Nabda 0.2.x is an early release. There has not been a complete independent security audit or production carrier validation. Local tests are useful evidence, not a guarantee that every deployment is secure.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/mohamedkbay/Nabda/security/advisories/new) when available. If private reporting has not been enabled, open an issue asking for a private contact channel without including exploit details, credentials or personal data.

Please include the affected version, relevant endpoint or file, reproduction steps using an isolated local installation, expected impact and a suggested fix if you have one. Do not include real API keys, OAuth secrets, phone numbers, message contents or exported databases.

Test only installations you own or have explicit permission to assess. Use sandbox messages. A report does not require contacting a real handset, sending SMS or accessing another person's workspace.

## Deployment responsibilities

Run the API over HTTPS, keep the dashboard on its configured API origin and protect provider secrets. The public website needs only the API/website origins; it never needs the GitHub Client Secret or D1 credentials.

Application keys, phone tokens and browser sessions are distinct credentials. Revoke any exposed application/device credential, rotate exposed provider secrets and invalidate affected sessions before restoring access. A revoked phone can still hold previously received offline work; stop that queue on the phone when necessary.

Keep Node.js, Wrangler, Android dependencies and your deployment configuration maintained. An installation owner is responsible for access, retention, backups and applicable carrier/data-handling obligations.
