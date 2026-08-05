import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface LicensePolicy {
  schema: number;
  license: string;
  openSourceBeforeChangeDate: boolean;
  licensedWork: {
    name: string;
    version: string;
    repository: string;
    changeDate: string;
    changeLicense: string;
  };
  allowedWithoutCommercialCredential: {
    privatePersonalNoncommercialProductionUse: boolean;
    nonProductionUses: string[];
  };
  restrictedUse: {
    requiresExecutedCommercialAgreement: boolean;
    requiresVerifiableAuthorizationCredentialForAutomatedSystems: boolean;
    defaultPermission: string;
  };
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
  it('matches the BUSL use boundary and pins valid signed revocation evidence', async () => {
    const policy = JSON.parse(await readFile('license-policy.json', 'utf8')) as LicensePolicy;
    const publicKey = createPublicKey(await readFile('LICENSE_PUBLIC_KEY.pem'));
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
    const revocations = await readFile('LICENSE_REVOCATIONS.json');
    const signature = Buffer.from((await readFile('LICENSE_REVOCATIONS.json.sig', 'utf8')).trim(), 'base64');

    expect(policy.schema).toBe(2);
    expect(policy.license).toBe('BUSL-1.1');
    expect(policy.openSourceBeforeChangeDate).toBe(false);
    expect(policy.licensedWork).toMatchObject({
      name: 'brother-lbx-web',
      version: '0.3.1',
      repository: 'https://github.com/smicbee/brother-lbx-web',
      changeDate: '2030-08-03',
      changeLicense: 'Apache-2.0',
    });
    expect(policy.allowedWithoutCommercialCredential.privatePersonalNoncommercialProductionUse).toBe(true);
    expect(policy.allowedWithoutCommercialCredential.nonProductionUses).toEqual([
      'evaluation',
      'testing',
      'development',
      'prototyping',
    ]);
    expect(policy.restrictedUse.requiresExecutedCommercialAgreement).toBe(true);
    expect(policy.restrictedUse.requiresVerifiableAuthorizationCredentialForAutomatedSystems).toBe(true);
    expect(policy.restrictedUse.defaultPermission).toBe('commercial-production-use');
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
      permissions: string[];
      writtenPermissionReference: string;
    };
    expect(example.grantId).toContain('REPLACE');
    expect(example.permissions).toContain('commercial-production-use');
    expect(example.writtenPermissionReference).toContain('REPLACE');
    await expect(readFile('authorization/commercial-license.example.json.sig')).rejects.toThrow();
  });
});
