import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface LicensePolicy {
  authorization: {
    signatureAlgorithm: string;
    publicKeyDerSha256: string;
  };
  revocation: {
    failClosed: boolean;
    maxAgeDays: number;
  };
}

describe('commercial authorization policy', () => {
  it('pins the Ed25519 public key and verifies the detached revocation signature', async () => {
    const policy = JSON.parse(await readFile('license-policy.json', 'utf8')) as LicensePolicy;
    const publicKey = createPublicKey(await readFile('LICENSE_PUBLIC_KEY.pem'));
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
    const revocations = await readFile('LICENSE_REVOCATIONS.json');
    const signature = Buffer.from((await readFile('LICENSE_REVOCATIONS.json.sig', 'utf8')).trim(), 'base64');

    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    expect(policy.authorization.signatureAlgorithm).toBe('Ed25519');
    expect(fingerprint).toBe(policy.authorization.publicKeyDerSha256);
    expect(signature).toHaveLength(64);
    expect(verify(null, revocations, publicKey, signature)).toBe(true);
    expect(policy.revocation.failClosed).toBe(true);
    expect(policy.revocation.maxAgeDays).toBeGreaterThan(0);
  });

  it('ships only an unsigned placeholder credential, never a live grant', async () => {
    const example = JSON.parse(await readFile('authorization/commercial-license.example.json', 'utf8')) as {
      grantId: string;
      writtenPermissionReference: string;
    };
    expect(example.grantId).toContain('REPLACE');
    expect(example.writtenPermissionReference).toContain('REPLACE');
    await expect(readFile('authorization/commercial-license.example.json.sig')).rejects.toThrow();
  });
});
