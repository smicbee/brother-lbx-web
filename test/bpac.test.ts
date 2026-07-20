import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BpacDocument, BpacPrinter, openBpacDocument } from '../src/bpac.js';

const fixture = resolve('test/fixtures/template.lbx');

async function openFixture(): Promise<BpacDocument> {
  return openBpacDocument(new Uint8Array(await readFile(fixture)));
}

function mediaInferenceFixture(twoColor = false, autoLength = true): Uint8Array {
  const label = `<?xml version="1.0"?><pt:document xmlns:pt="urn:pt" xmlns:style="urn:style"><pt:body><style:sheet><style:paper width="175.7pt" height="1000pt" orientation="landscape" autoLength="${String(autoLength)}" printColorDisplay="${String(twoColor)}" printerName="Brother QL-820NWB"/><pt:objects/></style:sheet></pt:body></pt:document>`;
  return zipSync({ 'label.xml': new TextEncoder().encode(label) });
}

describe('cross-platform b-PAC compatibility layer', () => {
  it('enumerates model-compatible media IDs and names without COM', () => {
    const printer = new BpacPrinter('QL-820NWB');
    const ids = printer.GetSupportedMediaIds();
    const names = printer.GetSupportedMediaNames();

    expect(printer.supported).toBe(true);
    expect(ids).toHaveLength(19);
    expect(names).toHaveLength(ids.length);
    expect(ids).toContain(259);
    expect(ids).not.toContain(260);
    expect(ids).not.toContain(365);
    expect(ids).not.toContain(366);
    expect(printer.IsMediaIdSupported(259)).toBe(true);
    expect(printer.IsMediaIdSupported(401)).toBe(false);
    expect(printer.getMedia(259)).toMatchObject({ id: 259, widthMm: 62, skus: ['DK-22205'] });
  });

  it('opens an LBX and provides b-PAC-style named object access', async () => {
    const document = await openFixture();
    const product = document.GetObject('product');

    expect(document.GetMediaId()).toBe(259);
    expect(document.GetMediaName()).toContain('DK-22205');
    expect(document.GetPrinter().name).toBe('Brother QL-820NWB');
    expect(product).toBeDefined();
    expect(product?.Type).toBe('text');

    if (!product) throw new Error('product fixture object missing');
    product.Text = 'Espresso';
    expect(product.GetData()).toBe('Espresso');
    expect(product.SetData(12.9)).toBe(true);
    expect(product.Text).toBe('12.9');
    expect(document.renderToSvg()).toContain('>12.9<');
  });

  it('sets media by ID or SKU and rejects unsupported media', async () => {
    const document = await openFixture();
    const originalHeight = document.document.paper.height;

    expect(document.SetMediaById(258, false)).toBe(true);
    expect(document.GetMediaId()).toBe(258);
    expect(document.document.paper.width).toBeCloseTo(29 * 72 / 25.4, 6);
    expect(document.document.paper.height).toBe(originalHeight);

    expect(document.SetMediaByName('dk-11201', false)).toBe(true);
    expect(document.GetMediaId()).toBe(271);
    expect(document.document.paper.height).toBeCloseTo(90 * 72 / 25.4, 6);
    expect(document.SetMediaById(260, false)).toBe(false);
    expect(document.SetMediaById(999999, false)).toBe(false);
    expect(document.SetMediaByName('not-a-roll', false)).toBe(false);
  });

  it('scales recursive object geometry when fitPage is requested', async () => {
    const document = await openFixture();
    const product = document.GetObject('product');
    if (!product) throw new Error('product fixture object missing');
    const before = { x: product.X, y: product.Y, width: product.Width, height: product.Height };
    const oldPaper = { width: document.document.paper.width, height: document.document.paper.height };

    expect(document.SetMediaById(271, true)).toBe(true);
    const scaleX = document.document.paper.width / oldPaper.width;
    const scaleY = document.document.paper.height / oldPaper.height;
    expect(product.X).toBeCloseTo(before.x * scaleX, 6);
    expect(product.Y).toBeCloseTo(before.y * scaleY, 6);
    expect(product.Width).toBeCloseTo(before.width * scaleX, 6);
    expect(product.Height).toBeCloseTo(before.height * scaleY, 6);
  });

  it('infers single- and two-color 62mm continuous media when format is absent', () => {
    expect(BpacDocument.open(mediaInferenceFixture(false)).GetMediaId()).toBe(259);
    expect(BpacDocument.open(mediaInferenceFixture(true)).GetMediaId()).toBe(251);
    expect(BpacDocument.open(mediaInferenceFixture(false, false)).GetMediaId()).toBe(259);
  });

  it('does not claim unsupported installed-printer capabilities', async () => {
    const printer = new BpacPrinter('Brother QL-9999');
    expect(printer.supported).toBe(false);
    expect(printer.GetSupportedMediaIds()).toEqual([]);

    const document = await openFixture();
    expect(document.SetPrinter('Brother QL-9999')).toBe(false);
    expect(document.GetPrinter().name).toBe('Brother QL-820NWB');
  });
});
