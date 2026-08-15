import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lbx-render CLI report', () => {
  const originalArgv = process.argv;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('exposes editable fields for print-service Additional info inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lbx-cli-'));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, 'report.json');
    process.argv = [
      process.execPath,
      'lbx-render',
      resolve('test/fixtures/template.lbx'),
      '--json',
      reportPath,
      '--set',
      'product=Additional information',
    ];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('../src/cli.js');

    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      editableFields: Array<{ name: string; kind: string; value: string; multiline: boolean; occurrences: number }>;
    };
    expect(report.editableFields.map((field) => field.name)).toEqual(['barcode', 'product', 'price', 'date', 'weight']);
    expect(report.editableFields.find((field) => field.name === 'product')).toEqual({
      name: 'product',
      kind: 'text',
      value: 'Additional information',
      multiline: true,
      occurrences: 1,
    });
  });
});