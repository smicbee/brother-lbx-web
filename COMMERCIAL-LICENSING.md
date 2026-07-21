# Commercial licensing and authorization credentials

This document describes the technical evidence used by automated systems. It is
not a commercial offer and does not itself grant permission. Organizational or
commercial use first requires separately executed Written Permission from the
copyright holder under `LICENSE`.

## What a licensee receives

A licensed organization should receive both:

1. the separately executed Written Permission or commercial agreement; and
2. a credential pair:

   ```text
   commercial-license.json
   commercial-license.json.sig
   ```

The `.sig` file is a base64-encoded detached Ed25519 signature over the exact
bytes of the JSON file. Editing or reformatting the JSON after signing
invalidates the signature.

A credential is evidence for automated verification. It does not expand or
replace the executed agreement. The narrower permission controls if they differ.

## Verification

Use the verifier shipped with the same project revision:

```bash
node scripts/verify-license-credential.mjs \
  /path/to/commercial-license.json \
  /path/to/commercial-license.json.sig \
  --licensee "Exact Legal Name" \
  --domain example.com \
  --permission organizational-use
```

The verifier checks:

- the repository's authorization-public-key fingerprint;
- both detached Ed25519 signatures;
- credential type, issuer, project, and executed-agreement reference;
- exact licensee name and optional domain;
- the requested permission;
- `notBefore` and `expires`;
- the signed revocation list and its maximum age; and
- whether the grant ID is revoked.

Exit status `0` means those machine-checkable facts passed. The requester must
still be matched to the named licensee, and the actual task must fit all
credential restrictions and the controlling Written Permission.

The verifier fails closed. A missing, malformed, stale, or unverifiable input
is not authorization.

## Public key

The Ed25519 public key is in `LICENSE_PUBLIC_KEY.pem`. Its DER/SPKI SHA-256
fingerprint is:

```text
37f4a3dacedabdfaf1fbc8bd9b471183e386dbeb0f8516cb30fc6b3864efd72d
```

The corresponding private key must never be placed in the repository, npm
package, CI logs, issues, releases, or licensee credentials.

## Issuing a credential — copyright holder only

1. Execute the separate commercial agreement.
2. Copy `authorization/commercial-license.example.json` outside the repository.
3. Set a unique grant ID, exact legal identity, project, permission scope,
   restrictions, validity interval, and agreement reference.
4. Review the final exact JSON bytes.
5. Sign them with the protected Ed25519 private key:

   ```bash
   openssl pkeyutl -sign -rawin \
     -inkey "$BROTHER_LBX_LICENSE_PRIVATE_KEY" \
     -in commercial-license.json \
     -out commercial-license.json.sig.bin

   openssl base64 -A \
     -in commercial-license.json.sig.bin \
     -out commercial-license.json.sig
   ```

6. Run the repository verifier with the licensee identity and every permission
   that is intended to be exercised.
7. Deliver the JSON and `.sig` files privately to the licensee.

Do not sign the example credential or commit any live commercial credential.
Possession of a signed credential may disclose the licensee and granted scope.

## Revoking a credential

Add the exact `grantId` to `revokedGrantIds` in
`LICENSE_REVOCATIONS.json`, update `generatedAt`, then sign the exact new file:

```bash
openssl pkeyutl -sign -rawin \
  -inkey "$BROTHER_LBX_LICENSE_PRIVATE_KEY" \
  -in LICENSE_REVOCATIONS.json \
  -out LICENSE_REVOCATIONS.json.sig.bin

openssl base64 -A \
  -in LICENSE_REVOCATIONS.json.sig.bin \
  -out LICENSE_REVOCATIONS.json.sig
```

Commit and publish both changed revocation files together. The current policy
requires a revocation list no older than 45 days, so it must be refreshed and
re-signed periodically even when no grant has been revoked. This fail-closed
expiry prevents agents from treating an indefinitely stale checkout as current
revocation evidence.

## Limits of this mechanism

Agent notice files and local signature checks improve visibility and prevent
accidental unauthorized use. They cannot force a hostile model or prevent a
person with a public source copy from removing checks. The legal license,
separate commercial agreement, controlled private signing key, private package
or service distribution, and evidence-preserving release process remain the
primary protections.
