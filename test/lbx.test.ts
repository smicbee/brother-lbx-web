import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { parseLBX, setObject, walkObjects } from '../src/parser.js';
import { escapeXml, renderToSvg } from '../src/svg.js';
import { renderSvgToPng, pngToQlRasterJob, pngToRawImageData } from '../src/node.js';

const fixture = resolve('test/fixtures/template.lbx');
const internetTextFixture = resolve('test/fixtures/internet/default-text-only-12mm.lbx');
const internetImageFixture = resolve('test/fixtures/internet/single_image.lbx');

async function loadFixture() {
  return parseLBX(new Uint8Array(await readFile(fixture)));
}

function tinyLbx(objects: string): Uint8Array {
  const label = `<?xml version="1.0"?><pt:document xmlns:pt="http://schemas.brother.info/ptouch/2007/lbx/main" xmlns:style="http://schemas.brother.info/ptouch/2007/lbx/style" xmlns:text="http://schemas.brother.info/ptouch/2007/lbx/text" xmlns:draw="urn:test"><pt:body><style:sheet name="Test"><style:paper width="100pt" height="50pt"/><pt:objects>${objects}</pt:objects></style:sheet></pt:body></pt:document>`;
  return zipSync({ 'label.xml': new TextEncoder().encode(label) });
}

describe('LBX parser and bindings', () => {
  it('parses the real fixture image, barcode, and nested table contents', async () => {
    const document = await loadFixture();
    expect(document.objects.map((object) => object.kind)).toEqual(['image', 'barcode', 'table']);
    expect(document.resources['Object0.jpg']?.mime).toBe('image/jpeg');
    expect(document.resources['Object0.jpg']?.bytes.length).toBeGreaterThan(1000);
    const nested = walkObjects(document);
    expect(nested.some((object) => object.kind === 'text' && object.name === 'product')).toBe(true);
    expect(nested.some((object) => object.kind === 'datetime' && object.name === 'date')).toBe(true);
    expect(nested.some((object) => object.kind === 'text' && object.name === 'weight')).toBe(true);
    expect(setObject(document, 'product', 'Coffee & Tea')).toBe(true);
    expect(setObject(document, 'barcode', 'ABC123')).toBe(true);
    expect(setObject(document, 'date', '2026-07-20')).toBe(true);
    expect(walkObjects(document).find((object) => object.name === 'product')).toMatchObject({ value: 'Coffee & Tea' });
  });

  it('warns with tag and path for unknown direct and nested objects', () => {
    const document = parseLBX(tinyLbx('<draw:polygon><pt:objectStyle x="1pt" y="1pt" width="2pt" height="2pt"/></draw:polygon><table:table xmlns:table="http://schemas.brother.info/ptouch/2007/lbx/table"><table:cells><table:cell><draw:star xmlns:draw="urn:test"/></table:cell></table:cells></table:table>'));
    expect(document.warnings.length).toBeGreaterThanOrEqual(2);
    expect(document.warnings.some((warning) => warning.tag === 'draw:polygon' && warning.path.includes('/pt:objects'))).toBe(true);
    expect(document.warnings.some((warning) => warning.tag === 'draw:star' && warning.path.includes('table:cell'))).toBe(true);
  });

  it('rejects unsafe ZIP paths before extracting resources', () => {
    const label = new TextEncoder().encode('<?xml version="1.0"?><pt:document xmlns:pt="urn:pt"><pt:body><pt:objects/></pt:body></pt:document>');
    const archive = zipSync({ 'label.xml': label, '../Object0.bmp': new Uint8Array([0x42, 0x4d]) });
    expect(() => parseLBX(archive)).toThrow(/Unsafe LBX ZIP entry path/);
  });

  it('rejects oversized XML from the central directory before inflation', () => {
    const oversized = new TextEncoder().encode(' '.repeat(8 * 1024 * 1024 + 1));
    const archive = zipSync({ 'label.xml': oversized }, { level: 9 });
    expect(() => parseLBX(archive)).toThrow(/label\.xml exceeds XML size limit/);
  });
});

describe('SVG safety and rendering', () => {
  it('escapes XML text and attributes', () => {
    expect(escapeXml(`<tag a="b"> & ' "`)).toBe('&lt;tag a=&quot;b&quot;&gt; &amp; &apos; &quot;');
    const document = parseLBX(tinyLbx('<text:text xmlns:text="http://schemas.brother.info/ptouch/2007/lbx/text"><pt:objectStyle x="1pt" y="1pt" width="80pt" height="20pt"><pt:expanded objectName="unsafe"/></pt:objectStyle><pt:data>a &amp; b &lt;c&gt;</pt:data></text:text>'));
    const svg = renderToSvg(document);
    expect(svg).toContain('a &amp; b &lt;c&gt;');
    expect(svg).not.toContain('a & b');
  });
});

describe('public internet LBX fixtures', () => {
  it('uses content bounds instead of the P-touch autoLength sentinel', async () => {
    const document = parseLBX(new Uint8Array(await readFile(internetTextFixture)));
    const svg = renderToSvg(document);
    expect(document.paper.attributes.autoLength).toBe('true');
    expect(svg).toContain('viewBox="0 0 45.6 33.6"');
    expect(svg).toContain('>abc<');

    const png = await renderSvgToPng(svg, { dpi: 300 });
    const raw = await pngToRawImageData(png);
    expect(raw.width).toBeGreaterThan(raw.height);
    expect(raw.height).toBeLessThan(200);
    const nonWhite = Array.from({ length: raw.width * raw.height }, (_, index) => {
      const offset = index * 4;
      return raw.data[offset] !== 255 || raw.data[offset + 1] !== 255 || raw.data[offset + 2] !== 255;
    }).filter(Boolean).length;
    expect(nonWhite).toBeGreaterThan(20);
  });

  it('renders an embedded BMP and creates a valid Brother QL raster stream', async () => {
    const document = parseLBX(new Uint8Array(await readFile(internetImageFixture)));
    expect(document.resources['Object0.bmp']?.mime).toBe('image/bmp');
    const svg = renderToSvg(document);
    expect(svg).toContain('viewBox="0 0 40.3 68"');
    expect(svg).toContain('data:image/bmp;base64,');

    const png = await renderSvgToPng(svg, { dpi: 300 });
    const raw = await pngToRawImageData(png);
    const nonWhite = Array.from({ length: raw.width * raw.height }, (_, index) => {
      const offset = index * 4;
      return raw.data[offset] !== 255 || raw.data[offset + 1] !== 255 || raw.data[offset + 2] !== 255;
    }).filter(Boolean).length;
    expect(nonWhite).toBeGreaterThan(100);

    const raster = await pngToQlRasterJob(png);
    expect(raster.length).toBeGreaterThan(1000);
    expect(Buffer.from(raster).includes(Buffer.from([0x1b, 0x40]))).toBe(true);
    expect(Buffer.from(raster).includes(Buffer.from([0x1b, 0x69, 0x7a]))).toBe(true);
  });
});
