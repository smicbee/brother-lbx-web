import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { encode as encodeBmp } from 'bmp-js';
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
    expect(document.objects[0]).toMatchObject({ kind: 'image', name: 'Image8', resourceName: 'Object0.jpg' });
    expect(document.objects[1]).toMatchObject({ kind: 'barcode', name: 'barcode', protocol: 'CODE39' });
    const table = document.objects.find((object) => object.kind === 'table');
    expect(table?.kind === 'table' ? table.cells : []).toHaveLength(8);
    expect(document.resources['Object0.jpg']?.mime).toBe('image/jpeg');
    expect(document.resources['Object0.jpg']?.bytes.length).toBeGreaterThan(1000);
    const nested = walkObjects(document);
    for (const name of ['product', 'price', 'weight', 'date']) expect(nested.some((object) => object.name === name)).toBe(true);
    for (const label of ['Product:', 'Price:', 'Packed On:', 'Weight:']) expect(nested.some((object) => object.kind === 'text' && object.value === label)).toBe(true);
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

  it('rejects deeply nested XML before DOM or recursive AST parsing', () => {
    const nested = `${'<draw:group>'.repeat(300)}${'</draw:group>'.repeat(300)}`;
    expect(() => parseLBX(tinyLbx(nested))).toThrow(/nesting-depth limit/);
  });

  it('requires valid paper dimensions and an objects container', () => {
    const missingObjects = zipSync({ 'label.xml': new TextEncoder().encode('<?xml version="1.0"?><pt:document xmlns:pt="urn:pt"><pt:body/></pt:document>') });
    expect(() => parseLBX(missingObjects)).toThrow(/no objects container/);
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

  it('renders known children nested inside an unsupported group', () => {
    const document = parseLBX(tinyLbx('<draw:group><pt:objectStyle x="0pt" y="0pt" width="90pt" height="30pt"/><text:text><pt:objectStyle x="2pt" y="2pt" width="50pt" height="15pt"/><pt:data>nested</pt:data></text:text></draw:group>'));
    const svg = renderToSvg(document);
    expect(document.warnings.some((warning) => warning.tag === 'draw:group')).toBe(true);
    expect(svg).toContain('unsupported LBX XML object draw:group');
    expect(svg).toContain('>nested<');
  });

  it('renders table labels and CODE39 as bars for the real fixture', async () => {
    const svg = renderToSvg(await loadFixture());
    for (const label of ['Product:', 'Price:', 'Packed On:', 'Weight:']) expect(svg).toContain(label);
    expect(svg).toContain('data-lbx-table=');
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(20);
  });

  it('uses the declared CODE39 wide-to-narrow bar ratio', () => {
    const document = parseLBX(tinyLbx('<barcode:barcode xmlns:barcode="http://schemas.brother.info/ptouch/2007/lbx/barcode"><pt:objectStyle x="0pt" y="0pt" width="90pt" height="20pt"/><barcode:barcodeStyle protocol="CODE39" barWidth="1pt" barRatio="1:2" humanReadable="false"/><pt:data>A</pt:data></barcode:barcode>'));
    const svg = renderToSvg(document);
    const widths = [...svg.matchAll(/<rect x="[^"]+" y="0" width="([\d.]+)" height="20"/g)].map((match) => Number.parseFloat(match[1] ?? ''));
    expect(widths.length).toBeGreaterThan(5);
    expect(Math.max(...widths) / Math.min(...widths)).toBeCloseTo(2, 4);
  });

  it('encodes image resources without requiring Buffer in the browser core', async () => {
    const document = await loadFixture();
    const expected = Buffer.from(document.resources['Object0.jpg']!.bytes).toString('base64');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'btoa');
    try {
      Object.defineProperty(globalThis, 'btoa', { value: undefined, configurable: true, writable: true });
      expect(renderToSvg(document)).toContain(`data:image/jpeg;base64,${expected}`);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'btoa', descriptor);
      else Reflect.deleteProperty(globalThis, 'btoa');
    }
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
    const rasterBuffer = Buffer.from(raster);
    const initializeAt = rasterBuffer.indexOf(Buffer.from([0x1b, 0x40]));
    const rasterModeAt = rasterBuffer.indexOf(Buffer.from([0x1b, 0x69, 0x61, 0x01]), initializeAt + 2);
    const printInformationAt = rasterBuffer.indexOf(Buffer.from([0x1b, 0x69, 0x7a]));
    expect(initializeAt).toBeGreaterThanOrEqual(0);
    expect(rasterModeAt).toBeGreaterThan(initializeAt);
    expect(printInformationAt).toBeGreaterThan(rasterModeAt);
    expect(rasterBuffer.includes(Buffer.from([0x67, 0x00]))).toBe(true);
    expect(rasterBuffer.includes(Buffer.from([0x1a])) || rasterBuffer.includes(Buffer.from([0x0c]))).toBe(true);
    await expect(pngToQlRasterJob(png, { mediaId: 999999 })).rejects.toThrow(/Unknown Brother media id/);
    await expect(pngToQlRasterJob(png, { printer: 'not-a-printer' as never })).rejects.toThrow(/Unsupported printer/);
    await expect(pngToQlRasterJob(png, { copies: 0 })).rejects.toThrow(/copies must be an integer/);
    await expect(pngToQlRasterJob(png, { copies: -1 })).rejects.toThrow(/copies must be an integer/);
  });

  it('rejects an SVG canvas that would exceed the decoded-pixel limit', async () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="10000pt" height="10000pt" viewBox="0 0 10000 10000"/>';
    await expect(renderSvgToPng(huge, { dpi: 300 })).rejects.toThrow(/pixel safety limit/);
  });

  it('rejects oversized BMP dimensions before decoding pixel memory', async () => {
    const bmp = Buffer.from(encodeBmp({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }).data);
    bmp.writeInt32LE(10_000, 18);
    bmp.writeInt32LE(10_000, 22);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image width="1" height="1" href="data:image/bmp;base64,${bmp.toString('base64')}"/></svg>`;
    await expect(renderSvgToPng(svg, { fitWidth: 10 })).rejects.toThrow(/pixel safety limit/);
  });

  it('renders a 24-bit BMP with opaque alpha and preserved colors', async () => {
    const bmp = encodeBmp({
      width: 2,
      height: 1,
      data: Buffer.from([
        255, 0, 0, 255,
        255, 0, 255, 0,
      ]),
    }).data;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><image width="2" height="1" preserveAspectRatio="none" href="data:image/bmp;base64,${bmp.toString('base64')}"/></svg>`;
    const raw = await pngToRawImageData(await renderSvgToPng(svg, { fitWidth: 20 }));
    const pixels = Array.from({ length: raw.width * raw.height }, (_, index) => Array.from(raw.data.slice(index * 4, index * 4 + 4)));
    expect(pixels.every((pixel) => pixel[3] === 255)).toBe(true);
    expect(pixels.some(([red, green, blue]) => red > 180 && green < 80 && blue < 80)).toBe(true);
    expect(pixels.some(([red, green, blue]) => green > 180 && red < 80 && blue < 80)).toBe(true);
  });
});
