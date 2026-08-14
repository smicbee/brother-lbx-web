import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLBX, renderToSvg, setObject, walkObjects } from '../src/index.js';
import { pngToRawImageData, renderSvgToPng } from '../src/node.js';

interface CorpusEntry {
  file: string;
  bytes: number;
  sha256: string;
}

interface CorpusManifest {
  source_archive: string;
  entry_count: number;
  native_datetime_objects: number;
  sanitization: string[];
  entries: CorpusEntry[];
}

const fixtureDirectory = resolve('test/fixtures/seo-fa-lab-rev1');
const manifest = JSON.parse(
  readFileSync(resolve(fixtureDirectory, 'manifest.json'), 'utf8'),
) as CorpusManifest;
const deterministicDateOptions = {
  printDate: new Date('2026-08-14T12:00:00Z'),
  locale: 'en-GB',
  timeZone: 'UTC',
} as const;

function fixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixtureDirectory, file)));
}

function nonWhitePixels(raw: { width: number; height: number; data: Uint8Array }): number {
  let count = 0;
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    if ((raw.data[offset] ?? 255) < 250 || (raw.data[offset + 1] ?? 255) < 250 || (raw.data[offset + 2] ?? 255) < 250) count += 1;
  }
  return count;
}

describe('user-supplied SEO/FA LBX regression corpus', () => {
  it('tracks every supplied LBX and LBX backup with exact hashes', () => {
    expect(manifest.source_archive).toBe('1_SEO_FA_LAB_rev1.zip');
    expect(manifest.entry_count).toBe(75);
    expect(manifest.sanitization).toContain(
      'Internal UNC printer queue names normalized to Brother PT-P950NW; label content and resources otherwise preserved.',
    );
    expect(manifest.entries).toHaveLength(manifest.entry_count);
    expect(new Set(manifest.entries.map((entry) => entry.file)).size).toBe(manifest.entry_count);
    expect(manifest.entries.filter((entry) => entry.file.endsWith('.lbx'))).toHaveLength(38);
    expect(manifest.entries.filter((entry) => entry.file.endsWith('.lbx.bak'))).toHaveLength(37);

    for (const entry of manifest.entries) {
      const bytes = fixtureBytes(entry.file);
      expect(bytes.length, entry.file).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.file).toBe(entry.sha256);
    }
  });

  it.each(manifest.entries)('parses and rasterizes $file', async ({ file }) => {
    const document = parseLBX(fixtureBytes(file));
    const objects = walkObjects(document);
    expect(document.sourceFiles, file).toContain('label.xml');
    expect(document.paper.width, file).toBeGreaterThan(0);
    expect(document.paper.height, file).toBeGreaterThan(0);
    expect(document.paper.printerName ?? '', file).not.toMatch(/^\\\\/);
    expect(objects.length, file).toBeGreaterThan(0);
    expect(document.warnings, file).toEqual([]);

    const svg = renderToSvg(document, deterministicDateOptions);
    expect(svg, file).toContain('<svg ');
    expect(svg, file).not.toContain('NaN');
    expect(svg, file).not.toContain('Infinity');

    const raw = await pngToRawImageData(await renderSvgToPng(svg, { fitWidth: 360 }));
    expect(raw.width, file).toBe(360);
    expect(raw.height, file).toBeGreaterThan(0);
    expect(nonWhitePixels(raw), file).toBeGreaterThan(0);
  });

  it('binds and renders every date_inlabqueue_date field as supplied text', () => {
    let fields = 0;
    for (const entry of manifest.entries) {
      const document = parseLBX(fixtureBytes(entry.file));
      const matching = walkObjects(document).filter((object) => object.name === 'date_inlabqueue_date');
      if (!matching.length) continue;
      fields += matching.length;
      expect(matching.every((object) => object.kind === 'text'), entry.file).toBe(true);
      expect(setObject(document, 'date_inlabqueue_date', 'Friday, 14 August, 2026'), entry.file).toBe(true);
      const svg = renderToSvg(document, deterministicDateOptions);
      const renderedText = [...svg.matchAll(/<tspan\b[^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1]).join(' ');
      expect(renderedText, entry.file).toContain('Friday, 14 August, 2026');
    }
    expect(fields).toBe(20);
  });

  it('records that this corpus has no native Brother DateTime object', () => {
    const nativeDateTimes = manifest.entries.flatMap((entry) =>
      walkObjects(parseLBX(fixtureBytes(entry.file))).filter((object) => object.kind === 'datetime'),
    );
    expect(manifest.native_datetime_objects).toBe(0);
    expect(nativeDateTimes).toEqual([]);
  });
});
