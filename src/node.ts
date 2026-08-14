import { DEVICES, encodeJobForEngine, findMedia, renderImage } from '@thermal-label/brother-ql-core';
import type { RawImageData } from '@thermal-label/brother-ql-core';
import { existsSync } from 'node:fs';
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

function imageAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function numericImageAttribute(tag: string, name: string, fallback: number): number {
  const value = Number.parseFloat(imageAttribute(tag, name) ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function meshThreshold(globalX: number, globalY: number, threshold: number): number {
  // Brother's MESH output follows a four-by-four ordered screen. The rotated
  // matrix and page-relative phase match the strict 1-bit b-PAC export; using
  // page coordinates also keeps adjacent images on one continuous screen.
  const matrix = [
    [15, 3, 12, 0],
    [7, 11, 4, 8],
    [13, 1, 14, 2],
    [5, 9, 6, 10],
  ] as const;
  const cell = matrix[(globalY + 2) & 3]?.[(globalX + 1) & 3] ?? 0;
  return (cell + 0.5) * 16 + (threshold - 128);
}

function contrastFactor(value: number): number {
  const normalized = Math.max(-255, Math.min(255, (value - 50) * 255 / 50));
  return (259 * (normalized + 255)) / (255 * (259 - normalized));
}

async function normalizeMonochromeImagesForResvg(svg: string, options: PngRenderOptions): Promise<string> {
  const viewBox = svg.match(/\bviewBox="[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)"/i);
  const viewBoxWidth = Number.parseFloat(viewBox?.[1] ?? '');
  if (!(viewBoxWidth > 0)) return svg;
  const scale = options.fitWidth ? options.fitWidth / viewBoxWidth : (options.dpi ?? 300) / 72;
  const tags = [...svg.matchAll(/<image\b[^>]*\bdata-lbx-mono-operation="BINARY"[^>]*\/>/gi)].map((match) => match[0]);
  if (!tags.length) return svg;

  const sharp = (await import('sharp')).default;
  let normalized = svg;
  for (const tag of tags) {
    // The observed b-PAC calibration covers the normal RGB proportions and
    // unrotated image objects. Preserve the SVG fallback rather than applying
    // a confidently wrong screen to unsupported reversed/rotated variants.
    if (imageAttribute(tag, 'data-lbx-mono-proportions-reversed') === '1' || imageAttribute(tag, 'transform')) continue;
    const href = imageAttribute(tag, 'href');
    const encoded = href?.match(/^data:image\/(?:png|jpe?g|bmp);base64,([A-Za-z0-9+/=]+)$/i)?.[1];
    if (!encoded) continue;
    const x = numericImageAttribute(tag, 'x', 0);
    const y = numericImageAttribute(tag, 'y', 0);
    const width = Math.max(1, Math.round(numericImageAttribute(tag, 'width', 0) * scale));
    const height = Math.max(1, Math.round(numericImageAttribute(tag, 'height', 0) * scale));
    assertPixelDimensions(width, height, 'Monochrome image');
    const resized = await sharp(Buffer.from(encoded, 'base64'), { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      // Transparent image pixels print as paper white. Flatten before examining
      // chroma or luminance so hidden RGB payloads do not become black artifacts.
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assertPixelDimensions(resized.info.width, resized.info.height, 'Monochrome image');

    const channels = resized.info.channels;
    // Some LBX resources are already Brother-preprocessed grayscale images even
    // though their XML still says BINARY/MESH. Re-screening those pixels changes
    // the stored halftone phase and moves them away from the native export.
    // Apply the color-to-mono conversion only when the resource still contains
    // actual chroma; grayscale resources remain byte-for-byte on the SVG path.
    let hasChroma = false;
    if (channels >= 3) {
      for (let source = 0; source < resized.data.length; source += channels) {
        const red = resized.data[source] ?? 255;
        const green = resized.data[source + 1] ?? red;
        const blue = resized.data[source + 2] ?? red;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 1) {
          hasChroma = true;
          break;
        }
      }
    }
    if (!hasChroma) continue;

    const redWeight = numericImageAttribute(tag, 'data-lbx-mono-red', 30);
    const greenWeight = numericImageAttribute(tag, 'data-lbx-mono-green', 59);
    const blueWeight = numericImageAttribute(tag, 'data-lbx-mono-blue', 11);
    const weightTotal = Math.max(1, redWeight + greenWeight + blueWeight);
    const threshold = numericImageAttribute(tag, 'data-lbx-mono-threshold', 128);
    const gamma = Math.max(1, numericImageAttribute(tag, 'data-lbx-mono-gamma', 100));
    const brightness = numericImageAttribute(tag, 'data-lbx-image-brightness', 50);
    const contrast = numericImageAttribute(tag, 'data-lbx-image-contrast', 50);
    const factor = contrastFactor(contrast);
    const brightnessOffset = (brightness - 50) * 255 / 50;
    const mesh = imageAttribute(tag, 'data-lbx-mono-dither')?.toUpperCase() === 'MESH';
    const reverse = imageAttribute(tag, 'data-lbx-mono-reverse') === '1';
    const originX = Math.round(x * scale);
    const originY = Math.round(y * scale);
    const binary = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels;
      const red = resized.data[source] ?? 255;
      const green = resized.data[source + Math.min(1, channels - 1)] ?? red;
      const blue = resized.data[source + Math.min(2, channels - 1)] ?? red;
      let luminance = (red * redWeight + green * greenWeight + blue * blueWeight) / weightTotal;
      luminance = 255 * Math.pow(Math.max(0, Math.min(255, luminance)) / 255, 100 / gamma);
      luminance = (luminance - 128) * factor + 128 + brightnessOffset;
      const localX = pixel % width;
      const localY = Math.floor(pixel / width);
      const cutoff = mesh ? meshThreshold(originX + localX, originY + localY, threshold) : threshold;
      const black = reverse ? luminance >= cutoff : luminance < cutoff;
      const value = black ? 0 : 255;
      binary[pixel * 3] = value;
      binary[pixel * 3 + 1] = value;
      binary[pixel * 3 + 2] = value;
    }
    const png = await sharp(binary, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const replacementHref = `data:image/png;base64,${png.toString('base64')}`;
    normalized = normalized.replace(tag, tag.replace(href, replacementHref));
  }
  return normalized;
}

export async function renderSvgToPng(svg: string, options: PngRenderOptions = {}): Promise<Uint8Array> {
  validateSvgCanvas(svg, options);
  await validateEmbeddedRasterImages(svg);
  const { Resvg } = await import('@resvg/resvg-js');
  const dpi = options.dpi ?? 300;
  let normalizedSvg = await normalizeEmbeddedBmpForResvg(svg);
  normalizedSvg = await normalizeMonochromeImagesForResvg(normalizedSvg, options);
  const liberationDir = '/usr/share/fonts/truetype/liberation';
  const crosextraDir = '/usr/share/fonts/truetype/crosextra';
  const fallbackFontFiles = [
    `${liberationDir}/LiberationSans-Regular.ttf`, `${liberationDir}/LiberationSans-Bold.ttf`,
    `${liberationDir}/LiberationSans-Italic.ttf`, `${liberationDir}/LiberationSans-BoldItalic.ttf`,
    `${liberationDir}/LiberationSerif-Regular.ttf`, `${liberationDir}/LiberationSerif-Bold.ttf`,
    `${liberationDir}/LiberationSerif-Italic.ttf`, `${liberationDir}/LiberationSerif-BoldItalic.ttf`,
    `${liberationDir}/LiberationMono-Regular.ttf`, `${liberationDir}/LiberationMono-Bold.ttf`,
    `${liberationDir}/LiberationMono-Italic.ttf`, `${liberationDir}/LiberationMono-BoldItalic.ttf`,
    `${crosextraDir}/Carlito-Regular.ttf`, `${crosextraDir}/Carlito-Bold.ttf`,
    `${crosextraDir}/Carlito-Italic.ttf`, `${crosextraDir}/Carlito-BoldItalic.ttf`,
    `${crosextraDir}/Caladea-Regular.ttf`, `${crosextraDir}/Caladea-Bold.ttf`,
    `${crosextraDir}/Caladea-Italic.ttf`, `${crosextraDir}/Caladea-BoldItalic.ttf`,
  ].filter(existsSync);
  // resvg scans font files but does not apply fontconfig aliases. Without this
  // explicit metric-compatible alias, an unavailable Arial can silently fall
  // back to a monospace face and change both wrapping and raster output.
  const fontAliases = [
    ['Arial', 'Liberation Sans', `${liberationDir}/LiberationSans-Regular.ttf`],
    ['Times New Roman', 'Liberation Serif', `${liberationDir}/LiberationSerif-Regular.ttf`],
    ['Courier New', 'Liberation Mono', `${liberationDir}/LiberationMono-Regular.ttf`],
    ['Calibri', 'Carlito', `${crosextraDir}/Carlito-Regular.ttf`],
    ['Cambria', 'Caladea', `${crosextraDir}/Caladea-Regular.ttf`],
  ] as const;
  for (const [requested, fallback, regularFile] of fontAliases) {
    if (existsSync(regularFile)) normalizedSvg = normalizedSvg.replaceAll(`font-family="${requested}"`, `font-family="${fallback}"`);
  }
  const fitTo = options.fitWidth ? { mode: 'width' as const, value: options.fitWidth } : { mode: 'zoom' as const, value: dpi / 96 };
  const resvg = new Resvg(normalizedSvg, {
    fitTo,
    font: fallbackFontFiles.length
      ? { loadSystemFonts: true, fontFiles: fallbackFontFiles, defaultFontFamily: 'Liberation Sans' }
      : { loadSystemFonts: true },
  });
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
  if (!media.targetModels?.includes('dk')) throw new Error(`Media id ${mediaId} requires a wide DK printer and is not compatible with QL-820NWB`);
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
