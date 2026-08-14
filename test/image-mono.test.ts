import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLBX, renderToSvg } from '../src/index.js';
import { pngToRawImageData, renderSvgToPng } from '../src/node.js';
import type { LbxImageObject } from '../src/types.js';

const corpus = resolve('test/fixtures/seo-fa-lab-rev1');

async function load(name: string) {
  return parseLBX(new Uint8Array(await readFile(resolve(corpus, name))));
}

function image(document: ReturnType<typeof parseLBX>): LbxImageObject {
  const object = document.objects.find((candidate): candidate is LbxImageObject => candidate.kind === 'image');
  if (!object) throw new Error('fixture has no image object');
  return object;
}

describe('Brother monochrome image styles', () => {
  it('preserves BINARY/MESH conversion and image-effect metadata', async () => {
    const normal = image(await load('SEO_FA_LAB_rev1.lbx'));
    expect(normal.mono).toEqual({
      operationKind: 'BINARY', reverse: false, ditherKind: 'MESH', threshold: 128,
      gamma: 100, ditherEdge: 0, red: 30, green: 59, blue: 11,
      proportionsReversed: false,
    });
    expect(normal.effect).toEqual({ kind: 'NONE', brightness: 50, contrast: 50 });

    const adjusted = image(await load('3_2_1_SEO_FA_LAB_rev1.lbx'));
    expect(adjusted.effect).toEqual({ kind: 'MONO', brightness: 47, contrast: 57 });
  });

  it('emits conversion metadata and rasterizes the color JPEG as deterministic monochrome MESH', async () => {
    const document = await load('SEO_FA_LAB_rev1.lbx');
    const svg = renderToSvg(document);
    expect(svg).toContain('data-lbx-mono-operation="BINARY"');
    expect(svg).toContain('data-lbx-mono-dither="MESH"');
    expect(svg).toContain('data-lbx-mono-red="30"');
    expect(svg).toContain('data-lbx-image-brightness="50"');
    expect(svg).toContain('<feColorMatrix type="matrix"');
    expect(svg).toMatch(/filter="url\(#lbx-image-mono-[a-f0-9]+\)"/);

    const first = await renderSvgToPng(svg, { dpi: 360 });
    const second = await renderSvgToPng(svg, { dpi: 360 });
    expect(second).toEqual(first);
    const raw = await pngToRawImageData(first);

    // x=119.2pt, y=5.8pt, 24pt square at 360 DPI => 596,29,120x120.
    let chromaticPixels = 0;
    let blackPixels = 0;
    for (let y = 29; y < 149; y += 1) {
      for (let x = 596; x < 716; x += 1) {
        const offset = (y * raw.width + x) * 4;
        const red = raw.data[offset] ?? 255;
        const green = raw.data[offset + 1] ?? 255;
        const blue = raw.data[offset + 2] ?? 255;
        if (red !== green || green !== blue) chromaticPixels += 1;
        if (red < 128) blackPixels += 1;
      }
    }
    expect(chromaticPixels).toBe(0);
    expect(blackPixels).toBeGreaterThan(1_200);
    expect(blackPixels).toBeLessThan(2_000);
  });

  it('does not re-screen an already grayscale Brother image resource', async () => {
    const document = await load('4_3_2_1_SEO_FA_LAB_rev1.lbx');
    const object = image(document);
    const raw = await pngToRawImageData(await renderSvgToPng(renderToSvg(document), { dpi: 360 }));
    const x0 = Math.round(object.bounds.x * 5);
    const y0 = Math.round(object.bounds.y * 5);
    const width = Math.round(object.bounds.width * 5);
    const height = Math.round(object.bounds.height * 5);
    const levels = new Set<number>();
    let chromaticPixels = 0;
    for (let y = y0; y < y0 + height; y += 1) {
      for (let x = x0; x < x0 + width; x += 1) {
        const offset = (y * raw.width + x) * 4;
        const red = raw.data[offset] ?? 255;
        const green = raw.data[offset + 1] ?? 255;
        const blue = raw.data[offset + 2] ?? 255;
        levels.add(red);
        if (red !== green || green !== blue) chromaticPixels += 1;
      }
    }
    expect(chromaticPixels).toBe(0);
    expect(levels.size).toBeGreaterThan(2);
  });

  it('preserves unsupported reversed RGB proportions without applying the calibrated screen', async () => {
    const document = await load('SEO_FA_LAB_rev1.lbx');
    const object = image(document);
    if (!object.mono) throw new Error('fixture has no monochrome metadata');
    object.mono.proportionsReversed = true;
    const svg = renderToSvg(document);
    expect(svg).toContain('data-lbx-mono-proportions-reversed="1"');
    expect(svg).not.toContain('<feColorMatrix type="matrix"');
    const raw = await pngToRawImageData(await renderSvgToPng(svg, { dpi: 360 }));
    let chromaticPixels = 0;
    for (let y = 29; y < 149; y += 1) {
      for (let x = 596; x < 716; x += 1) {
        const offset = (y * raw.width + x) * 4;
        const red = raw.data[offset] ?? 255;
        const green = raw.data[offset + 1] ?? 255;
        const blue = raw.data[offset + 2] ?? 255;
        if (red !== green || green !== blue) chromaticPixels += 1;
      }
    }
    expect(chromaticPixels).toBeGreaterThan(0);
  });

  it('composites transparent source pixels onto paper white before screening', async () => {
    const sharp = (await import('sharp')).default;
    const source = await sharp(Buffer.from([
      0, 0, 0, 0,
      0, 0, 0, 255,
    ]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
    const href = `data:image/png;base64,${source.toString('base64')}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2pt" height="1pt" viewBox="0 0 2 1"><rect width="2" height="1" fill="#fff"/><image x="0" y="0" width="2" height="1" href="${href}" preserveAspectRatio="none" data-lbx-mono-operation="BINARY" data-lbx-mono-dither="MESH" data-lbx-mono-threshold="128" data-lbx-mono-gamma="100" data-lbx-mono-red="30" data-lbx-mono-green="59" data-lbx-mono-blue="11" data-lbx-mono-reverse="0" data-lbx-mono-proportions-reversed="0" /></svg>`;
    const raw = await pngToRawImageData(await renderSvgToPng(svg, { dpi: 72 }));
    expect(Array.from(raw.data.slice(0, 8))).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);
  });
});
