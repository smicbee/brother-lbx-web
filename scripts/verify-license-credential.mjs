#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REPOSITORY = 'https://github.com/smicbee/brother-lbx-web';
const EXPECTED_PROJECT = 'brother-lbx-web';
const EXPECTED_CREDENTIAL_TYPE = 'brother-lbx-web-commercial-license';
const EXPECTED_REVOCATION_TYPE = 'brother-lbx-web-license-revocations';

function fail(message) {
  console.error(`Authorization verification failed: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function parseSignature(text, label) {
  const encoded = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(`${label} is not a base64 signature`);
  const signature = Buffer.from(encoded, 'base64');
  if (signature.byteLength !== 64) fail(`${label} is not a 64-byte Ed25519 signature`);
  return signature;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertProject(value, label) {
  if (!value || value.name !== EXPECTED_PROJECT || value.repository !== EXPECTED_REPOSITORY) {
    fail(`${label} does not identify ${EXPECTED_REPOSITORY}`);
  }
}

function parseDate(value, label) {
  if (typeof value !== 'string') fail(`${label} is missing`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} is not a valid timestamp`);
  return timestamp;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log(`Usage:
  node scripts/verify-license-credential.mjs <credential.json> <credential.json.sig> \\
    --licensee "Exact Legal Name" --permission <permission> [--domain <domain>]

The signature files contain base64-encoded detached Ed25519 signatures.
The verifier fails closed if identity, scope, dates, project, public-key
fingerprint, signatures, or revocation status cannot be verified.`);
  process.exit(args.includes('--help') ? 0 : 1);
}

const credentialPath = args[0];
const signaturePath = args[1];
if (!credentialPath || !signaturePath || credentialPath.startsWith('--') || signaturePath.startsWith('--')) {
  fail('credential and signature paths are required');
}
const expectedLicensee = option(args, '--licensee');
const expectedPermission = option(args, '--permission');
const expectedDomain = option(args, '--domain');
if (!expectedLicensee) fail('--licensee is required for requester matching');
if (!expectedPermission) fail('--permission is required for scope matching');

const [publicKeyBytes, policyBytes, credentialBytes, credentialSignatureText, revocationBytes, revocationSignatureText] = await Promise.all([
  readFile(resolve(root, 'LICENSE_PUBLIC_KEY.pem')),
  readFile(resolve(root, 'license-policy.json')),
  readFile(resolve(credentialPath)),
  readFile(resolve(signaturePath), 'utf8'),
  readFile(resolve(root, 'LICENSE_REVOCATIONS.json')),
  readFile(resolve(root, 'LICENSE_REVOCATIONS.json.sig'), 'utf8'),
]).catch((error) => fail(`required file cannot be read: ${error instanceof Error ? error.message : String(error)}`));

const policy = parseJson(policyBytes, 'license-policy.json');
const publicKey = createPublicKey(publicKeyBytes);
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const fingerprint = createHash('sha256').update(publicDer).digest('hex');
if (fingerprint !== policy?.authorization?.publicKeyDerSha256) fail('authorization public-key fingerprint does not match license-policy.json');
if (policy?.authorization?.signatureAlgorithm !== 'Ed25519') fail('license-policy.json does not require Ed25519');

const credentialSignature = parseSignature(credentialSignatureText, 'credential signature');
if (!verify(null, credentialBytes, publicKey, credentialSignature)) fail('credential signature is invalid');
const credential = parseJson(credentialBytes, 'credential');

if (credential.schema !== 1 || credential.credentialType !== EXPECTED_CREDENTIAL_TYPE) fail('credential type or schema is invalid');
if (credential.issuer?.id !== 'smicbee') fail('credential issuer is invalid');
assertProject(credential.project, 'credential');
if (typeof credential.grantId !== 'string' || credential.grantId.length < 4 || credential.grantId.includes('REPLACE')) fail('credential grantId is invalid');
if (typeof credential.writtenPermissionReference !== 'string' || credential.writtenPermissionReference.length < 4 || credential.writtenPermissionReference.includes('REPLACE')) fail('credential has no executed Written Permission reference');
if (typeof credential.licensee?.legalName !== 'string' || credential.licensee.legalName.localeCompare(expectedLicensee, undefined, { sensitivity: 'accent' }) !== 0) fail('credential licensee does not match --licensee');
if (expectedDomain && (typeof credential.licensee?.domain !== 'string' || credential.licensee.domain.toLowerCase() !== expectedDomain.toLowerCase())) fail('credential domain does not match --domain');
if (!Array.isArray(credential.permissions) || !credential.permissions.includes(expectedPermission)) fail(`credential does not grant permission ${expectedPermission}`);

const now = Date.now();
const notBefore = parseDate(credential.notBefore, 'credential notBefore');
const expires = parseDate(credential.expires, 'credential expires');
if (expires <= notBefore) fail('credential validity interval is invalid');
if (now < notBefore) fail('credential is not yet valid');
if (now > expires) fail('credential has expired');

const revocationSignature = parseSignature(revocationSignatureText, 'revocation-list signature');
if (!verify(null, revocationBytes, publicKey, revocationSignature)) fail('revocation-list signature is invalid');
const revocations = parseJson(revocationBytes, 'revocation list');
if (revocations.schema !== 1 || revocations.credentialType !== EXPECTED_REVOCATION_TYPE) fail('revocation-list type or schema is invalid');
assertProject(revocations.project, 'revocation list');
if (!Array.isArray(revocations.revokedGrantIds) || !revocations.revokedGrantIds.every((value) => typeof value === 'string')) fail('revocation list is malformed');
const generatedAt = parseDate(revocations.generatedAt, 'revocation-list generatedAt');
const maxAgeDays = policy?.revocation?.maxAgeDays;
if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) fail('license-policy.json has no valid revocation maxAgeDays');
if (generatedAt > now + 5 * 60 * 1000) fail('revocation list is dated in the future');
if (now - generatedAt > maxAgeDays * 24 * 60 * 60 * 1000) fail(`revocation list is older than ${maxAgeDays} days`);
if (revocations.revokedGrantIds.includes(credential.grantId)) fail(`credential ${credential.grantId} has been revoked`);

console.log(JSON.stringify({
  authorized: true,
  grantId: credential.grantId,
  licensee: credential.licensee,
  matchedPermission: expectedPermission,
  permissions: credential.permissions,
  restrictions: credential.restrictions ?? {},
  notBefore: credential.notBefore,
  expires: credential.expires,
  writtenPermissionReference: credential.writtenPermissionReference,
  publicKeyDerSha256: fingerprint,
  revocationListGeneratedAt: revocations.generatedAt,
}, null, 2));
