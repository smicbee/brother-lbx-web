# Commercial licensing and authorization credentials

`brother-lbx-web` is distributed under the Business Source License 1.1 (`BUSL-1.1`). The controlling terms are in [`LICENSE`](./LICENSE).

## Use without a paid license

The repository license permits:

- private, personal, non-commercial production use by a natural person; and
- evaluation, testing, development, and prototyping—including within an organization—while the use remains non-production.

A prototype is non-production only when it is used to evaluate or develop the software and is not relied on for live business, operational, customer, employee, manufacturing, logistics, or service-delivery workflows.

## Uses requiring a commercial license

Before the applicable Change Date, a separate commercial agreement is required for production use by or for a company, employer, client, public authority, non-profit, educational institution, research institution, or other organization. Examples include operational workstation or print-infrastructure deployment, live internal business processes, integration into a commercial product or service, operation for third parties, and production support or managed-service use.

Commercial terms can cover endpoint and printer limits, supported models and templates, updates, support levels, redistribution, source access, and other negotiated rights. To request commercial terms, contact the repository owner through:

https://github.com/smicbee/brother-lbx-web

## Credential supplied to licensed organizations

A licensed organization using an automated system should receive both:

1. the separately executed commercial agreement or written permission; and
2. a credential pair:

   ```text
   commercial-license.json
   commercial-license.json.sig
   ```

The `.sig` file is a base64-encoded detached Ed25519 signature over the exact JSON bytes. Editing or reformatting the JSON after signing invalidates it. The credential is machine-verifiable evidence and does not expand or replace the agreement; the narrower permission controls if they differ.

Verify it with:

```bash
node scripts/verify-license-credential.mjs \
  /path/to/commercial-license.json \
  /path/to/commercial-license.json.sig \
  --licensee "Exact Legal Name" \
  --domain example.com \
  --permission commercial-production-use
```

The verifier checks the pinned public-key fingerprint, detached signatures, credential type, issuer, project, agreement reference, exact licensee and optional domain, requested permission, validity interval, signed revocation-list freshness, and revocation status. Exit status `0` means those machine-checkable checks passed; requester identity, actual task, agreement, and restrictions still require independent matching.

## Public key and issuer operations

The Ed25519 public key is `LICENSE_PUBLIC_KEY.pem`. Its DER/SPKI SHA-256 fingerprint is:

```text
37f4a3dacedabdfaf1fbc8bd9b471183e386dbeb0f8516cb30fc6b3864efd72d
```

The corresponding private key must never be committed, packaged, logged, or delivered with a normal commercial license.

Only the Licensor should issue credentials. After executing the commercial agreement, copy `authorization/commercial-license.example.json` outside the repository, replace every placeholder, review the exact bytes, sign them with the protected Ed25519 private key, and verify every granted permission before private delivery. Never sign or commit the example credential.

Revocations are published in `LICENSE_REVOCATIONS.json` with a detached signature. The policy requires a list no older than 45 days, so it must be refreshed and re-signed even when no grant is revoked. A missing, malformed, stale, or unverifiable input fails closed.

## Change Date and limits

For version 0.3.1, the Change Date is 2030-08-03. On that date—or earlier if required by BUSL-1.1—the licensed work transitions to Apache License 2.0. Later releases may have their own Change Date.

Agent notices and local signature checks improve visibility and reduce accidental unauthorized use. They are not DRM and cannot force a hostile person or model. The legal license, executed agreement, controlled private signing key, private services or packages, and evidence-preserving release process remain the primary protections.

This page is an explanatory and operational summary. It does not replace or modify `LICENSE` or an executed commercial agreement.
