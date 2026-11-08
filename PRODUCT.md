# Nabda

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Developers and small teams who want to send SMS from their own Android phone and SIM through an HTTP API.

## Product Purpose
Free public API and dashboard. Android owns the durable queue, recipients, message bodies, attempts, and SMS part results. Server manages accounts, scoped keys, pairing, temporary handoff commands, and result metadata.

## Capabilities and Constraints
Cloudflare-compatible free-tier deployment. Optional support does not unlock features. Each user supplies phone, SIM and carrier service. No real SMS during development. Signed debug APK until separate release signing. Cloud temporarily holds content until durable device acknowledgment; no false zero-storage promise. No guarantee of instant dispatch, delivery or unlimited free-tier capacity.

The free downloadable integration kit contains the Android test APK, package-free Node.js/Python clients, sandbox Postman collection with blank environment, OpenAPI contract, English guide and checksums. Clients default to sandbox, require explicit live selection and never automatically retry with new idempotency keys. It does not distribute account data, credentials or backend source, and does not install a Windows controller. Sandbox can be exercised before SIM/SMS permission; real carrier sending needs the selected SIM and Android permissions.

## Brand Commitments
Nabda, written in English only on the public site. Cairo body type and handwritten captions. The public website is one long static illustrated explanation, without a header, footer, menu, corner logo, buttons or Connect CTA. Project and API details appear within the story. User-approved black ink cartoons on warm paper with mint and peach. Plain human copy. Display LYPay and OnePay numbers verbatim as optional support, without invented checkout or payment QR. The separate account dashboard is a utility for keys and pairing.

## Evidence on Hand
Hand-drawn API diagram reference; httpSMS and Android research. Implementation contract docs/protocol-v1.md. Original local folders were not found; this is an independent implementation.
