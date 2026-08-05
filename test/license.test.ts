import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('distribution license metadata', () => {
  it('ships the BUSL-1.1 terms and commercial licensing notice consistently', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      version: string;
      license: string;
      files: string[];
    };
    const license = await readFile('LICENSE', 'utf8');
    const readme = await readFile('README.md', 'utf8');
    const commercial = await readFile('COMMERCIAL-LICENSING.md', 'utf8');
    const llms = await readFile('LLMS.md', 'utf8');
    const policy = JSON.parse(await readFile('license-policy.json', 'utf8')) as {
      schema: number;
      license: string;
      restrictedUse: { defaultPermission: string };
    };

    expect(packageJson.version).toBe('0.3.1');
    expect(packageJson.license).toBe('BUSL-1.1');
    expect(packageJson.files).toContain('LICENSE');
    expect(packageJson.files).toContain('COMMERCIAL-LICENSING.md');
    expect(license).toContain('Business Source License 1.1');
    expect(license).toContain('Change Date: 2030-08-03');
    expect(license).toContain('Change License: Apache License, Version 2.0');
    expect(license).toContain('prototyping that remain non-production uses are permitted');
    expect(readme).toContain('Commercial or organizational production use requires a separate paid license');
    expect(readme).toContain('LLMS.md');
    expect(commercial).toContain('private, personal, non-commercial production use');
    expect(llms).toContain('commercial-production-use');
    expect(llms).toContain('non-production evaluation, testing, development, or prototyping');
    expect(policy.schema).toBe(2);
    expect(policy.license).toBe('BUSL-1.1');
    expect(policy.restrictedUse.defaultPermission).toBe('commercial-production-use');
  });
});
