import { findMedia, encodeJob, renderImage } from '@thermal-label/brother-ql-core';
import type { RawImageData } from '@thermal-label/brother-ql-core';
import type { QlRasterOptions } from './types.js';

export interface PngRenderOptions {
  dpi?: number;
  fitWidth?: number;
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
    const decoded = bmpModule.decode(Buffer.from(encoded, 'base64'));
    const rgba = Buffer.alloc(decoded.width * decoded.height * 4);
    for (let source = 0, target = 0; source < decoded.data.length; source += 4, target += 4) {
      // bmp-js decodes pixels as ABGR.
      rgba[target] = decoded.data[source + 3] ?? 0;
      rgba[target + 1] = decoded.data[source + 2] ?? 0;
      rgba[target + 2] = decoded.data[source + 1] ?? 0;
      rgba[target + 3] = decoded.data[source] ?? 255;
    }
    const png = await sharp(rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    normalized = normalized.replaceAll(full, `data:image/png;base64,${png.toString('base64')}`);
  }
  return normalized;
}

export async function renderSvgToPng(svg: string, options: PngRenderOptions = {}): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const dpi = options.dpi ?? 300;
  const normalizedSvg = await normalizeEmbeddedBmpForResvg(svg);
  const resvg = new Resvg(normalizedSvg, options.fitWidth ? { fitTo: { mode: 'width', value: options.fitWidth } } : { fitTo: { mode: 'zoom', value: dpi / 96 } });
  return new Uint8Array(resvg.render().asPng());
}

export async function pngToRawImageData(png: Uint8Array): Promise<RawImageData> {
  const sharpModule = await import('sharp');
  const result = await sharpModule.default(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: result.info.width, height: result.info.height, data: new Uint8Array(result.data) };
}

function defaultMedia() {
  const media = findMedia(259);
  if (!media) throw new Error('thermal-label media registry has no QL-62mm continuous media (id 259)');
  return media;
}

export async function rawImageDataToQlRasterJob(raw: RawImageData, options: QlRasterOptions = {}): Promise<Uint8Array> {
  const media = findMedia(options.mediaId ?? 259) ?? defaultMedia();
  const bitmap = renderImage(raw, { dither: 'floyd-steinberg' });
  return encodeJob([{
    bitmap,
    media,
    options: {
      autoCut: options.autoCut ?? true,
      cutAtEnd: options.cutAtEnd ?? true,
      marginDots: options.marginDots ?? 35,
      compress: true,
    },
  }], { copies: options.copies ?? 1 });
}

export async function pngToQlRasterJob(png: Uint8Array, options: QlRasterOptions = {}): Promise<Uint8Array> {
  const media = findMedia(options.mediaId ?? 259) ?? defaultMedia();
  const raw = await pngToRawImageData(png);
  const targetWidth = media.printableDots ?? 696;
  if (raw.width === targetWidth) return rawImageDataToQlRasterJob(raw, options);
  const sharpModule = await import('sharp');
  const resized = await sharpModule.default(png).resize({ width: targetWidth, fit: 'contain', background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return rawImageDataToQlRasterJob({ width: resized.info.width, height: resized.info.height, data: new Uint8Array(resized.data) }, options);
}
