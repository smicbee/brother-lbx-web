import { DEVICES, encodeJobForEngine, findMedia, renderImage } from '@thermal-label/brother-ql-core';
import type { RawImageData } from '@thermal-label/brother-ql-core';
import type { QlRasterOptions } from './types.js';

export interface PngRenderOptions {
  dpi?: number;
  fitWidth?: number;
}

const MAX_IMAGE_PIXELS = 25_000_000;

function assertPixelDimensions(width: number | undefined, height: number | undefined, context: string): asserts width is number {
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`${context} exceeds the ${MAX_IMAGE_PIXELS}-pixel safety limit`);
  }
}

function validateSvgCanvas(svg: string, options: PngRenderOptions): void {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*["']/i);
  if (!match) return;
  const width = Number.parseFloat(match[1] ?? '');
  const height = Number.parseFloat(match[2] ?? '');
  if (!(width > 0) || !(height > 0)) throw new Error('SVG has invalid viewBox dimensions');
  const outputWidth = options.fitWidth ?? width * ((options.dpi ?? 300) / 72);
  const outputHeight = outputWidth * height / width;
  if (!Number.isFinite(outputWidth) || !Number.isFinite(outputHeight) || outputWidth * outputHeight > MAX_IMAGE_PIXELS) {
    throw new Error(`SVG output exceeds the ${MAX_IMAGE_PIXELS}-pixel safety limit`);
  }
}

async function normalizeEmbeddedBmpForResvg(svg: string): Promise<string> {
  const matches = [...svg.matchAll(/data:image\/bmp;base64,([A-Za-z0-9+/=]+)/g)];
  if (!matches.length) return svg;
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default;
  let normalized = svg;
  for (const match of matches) {
    const full = match[0];
    const encoded = match[1];
    if (!encoded) continue;
    const bmpModule = await import('bmp-js');
    const bmpBytes = Buffer.from(encoded, 'base64');
    if (bmpBytes.length < 26 || bmpBytes[0] !== 0x42 || bmpBytes[1] !== 0x4d) throw new Error('Embedded BMP has an invalid header');
    const headerWidth = Math.abs(bmpBytes.readInt32LE(18));
    const headerHeight = Math.abs(bmpBytes.readInt32LE(22));
    assertPixelDimensions(headerWidth, headerHeight, 'Embedded BMP');
    const decoded = bmpModule.decode(bmpBytes);
    assertPixelDimensions(decoded.width, decoded.height, 'Embedded BMP');
    const rgba = Buffer.alloc(decoded.width * decoded.height * 4);
    const preserveAlpha = decoded.bitPP === 32 && decoded.data.some((value, index) => index % 4 === 0 && value !== 0);
    for (let source = 0, target = 0; source < decoded.data.length; source += 4, target += 4) {
      // bmp-js decodes pixels as ABGR. 24-bit BMPs and many 32-bit BMPs
      // use a zero alpha byte as padding, which must be treated as opaque.
      rgba[target] = decoded.data[source + 3] ?? 0;
      rgba[target + 1] = decoded.data[source + 2] ?? 0;
      rgba[target + 2] = decoded.data[source + 1] ?? 0;
      rgba[target + 3] = preserveAlpha ? (decoded.data[source] ?? 255) : 255;
    }
    const png = await sharp(rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    normalized = normalized.replaceAll(full, `data:image/png;base64,${png.toString('base64')}`);
  }
  return normalized;
}

async function validateEmbeddedRasterImages(svg: string): Promise<void> {
  const matches = [...svg.matchAll(/data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)/gi)];
  if (!matches.length) return;
  const sharp = (await import('sharp')).default;
  for (const match of matches) {
    const encoded = match[2];
    if (!encoded) continue;
    const metadata = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    assertPixelDimensions(metadata.width, metadata.height, `Embedded ${match[1]?.toUpperCase() ?? 'image'}`);
  }
}

export async function renderSvgToPng(svg: string, options: PngRenderOptions = {}): Promise<Uint8Array> {
  validateSvgCanvas(svg, options);
  await validateEmbeddedRasterImages(svg);
  const { Resvg } = await import('@resvg/resvg-js');
  const dpi = options.dpi ?? 300;
  const normalizedSvg = await normalizeEmbeddedBmpForResvg(svg);
  const resvg = new Resvg(normalizedSvg, options.fitWidth ? { fitTo: { mode: 'width', value: options.fitWidth } } : { fitTo: { mode: 'zoom', value: dpi / 96 } });
  return new Uint8Array(resvg.render().asPng());
}

export async function pngToRawImageData(png: Uint8Array): Promise<RawImageData> {
  const sharpModule = await import('sharp');
  const result = await sharpModule.default(png, { limitInputPixels: MAX_IMAGE_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertPixelDimensions(result.info.width, result.info.height, 'PNG');
  return { width: result.info.width, height: result.info.height, data: new Uint8Array(result.data) };
}

function resolveMedia(mediaId?: number) {
  if (mediaId === undefined) {
    const media = findMedia(259);
    if (!media) throw new Error('thermal-label media registry has no QL-62mm continuous media (id 259)');
    return media;
  }
  const media = findMedia(mediaId);
  if (!media) throw new Error(`Unknown Brother media id: ${mediaId}`);
  if (media.tapeSystem !== 'dk') throw new Error(`Media id ${mediaId} is not compatible with QL-820NWB DK media`);
  return media;
}

function resolvePrinter(printer = 'QL-820NWB') {
  if (printer !== 'QL-820NWB' && printer !== 'QL-820NWBc') throw new Error(`Unsupported printer for this MVP: ${printer}`);
  const device = DEVICES.QL_820NWBc;
  const engine = device.engines.find((candidate) => candidate.protocol === 'ql-raster');
  if (!engine) throw new Error(`${device.name} has no QL raster engine`);
  return { device, engine };
}

export async function rawImageDataToQlRasterJob(raw: RawImageData, options: QlRasterOptions = {}): Promise<Uint8Array> {
  assertPixelDimensions(raw.width, raw.height, 'Raw label image');
  if (raw.data.byteLength !== raw.width * raw.height * 4) throw new Error('Raw label image data length does not match RGBA dimensions');
  const copies = options.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 999) throw new Error('copies must be an integer between 1 and 999');
  const media = resolveMedia(options.mediaId);
  const { device, engine } = resolvePrinter(options.printer);
  const bitmap = renderImage(raw, { dither: 'floyd-steinberg' });
  return encodeJobForEngine([{
    bitmap,
    media,
    options: {
      autoCut: options.autoCut ?? true,
      cutAtEnd: options.cutAtEnd ?? true,
      marginDots: options.marginDots ?? 35,
      compress: true,
    },
  }], { copies }, engine, device.name);
}

export async function pngToQlRasterJob(png: Uint8Array, options: QlRasterOptions = {}): Promise<Uint8Array> {
  const media = resolveMedia(options.mediaId);
  resolvePrinter(options.printer);
  const raw = await pngToRawImageData(png);
  const targetWidth = media.printableDots ?? 696;
  if (raw.width === targetWidth) return rawImageDataToQlRasterJob(raw, options);
  const sharpModule = await import('sharp');
  const resized = await sharpModule.default(png, { limitInputPixels: MAX_IMAGE_PIXELS }).resize({ width: targetWidth, fit: 'contain', background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertPixelDimensions(resized.info.width, resized.info.height, 'Resized label');
  return rawImageDataToQlRasterJob({ width: resized.info.width, height: resized.info.height, data: new Uint8Array(resized.data) }, options);
}
