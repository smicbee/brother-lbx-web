import type {
  LbxBarcodeObject, LbxDateTimeObject, LbxDocument, LbxImageObject, LbxObject,
  LbxPointRect, LbxResource, LbxTableObject, LbxTextObject, SvgRenderOptions,
} from './types.js';

const CODE39: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn',
  F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn',
  P: 'nnwnwnnwn', Q: 'nnnnnnwwn', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn',
  Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function rectAttrs(rect: LbxPointRect): string {
  return `x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}"`;
}

function transform(rect: LbxPointRect, angle: number): string {
  return angle ? ` transform="rotate(${fmt(angle)} ${fmt(rect.x + rect.width / 2)} ${fmt(rect.y + rect.height / 2)})"` : '';
}

function base64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function imageHref(resource: LbxResource, options: SvgRenderOptions): string {
  if (options.imageResolver) return options.imageResolver(resource);
  return `data:${resource.mime};base64,${base64(resource.bytes)}`;
}

function textY(object: LbxTextObject): number {
  if (object.verticalAlign === 'TOP') return object.bounds.y + object.fontSize;
  if (object.verticalAlign === 'BOTTOM') return object.bounds.y + object.bounds.height;
  return object.bounds.y + object.bounds.height / 2 + object.fontSize * 0.35;
}

function textAnchor(object: LbxTextObject): 'start' | 'middle' | 'end' {
  if (object.horizontalAlign === 'RIGHT') return 'end';
  if (object.horizontalAlign === 'CENTER') return 'middle';
  return 'start';
}

function renderText(object: LbxTextObject, options: SvgRenderOptions): string {
  const lines = object.value.split(/\r?\n/);
  const anchor = textAnchor(object);
  const x = anchor === 'end' ? object.bounds.x + object.bounds.width : anchor === 'middle' ? object.bounds.x + object.bounds.width / 2 : object.bounds.x;
  const fontSize = object.fontSize || options.defaultFontSize || 10;
  const family = escapeXml(object.fontFamily || options.fontFamily || 'Arial, sans-serif');
  const lineHeight = fontSize * 1.2;
  const text = lines.map((line, index) => `<tspan x="${fmt(x)}" dy="${index ? fmt(lineHeight) : '0'}">${escapeXml(line)}</tspan>`).join('');
  return `<text x="${fmt(x)}" y="${fmt(textY(object))}" text-anchor="${anchor}" font-family="${family}" font-size="${fmt(fontSize)}" fill="${escapeXml(object.color)}"${transform(object.bounds, object.angle)}>${text}</text>`;
}

function renderImage(object: LbxImageObject): string {
  if (!object.resource) return `<!-- missing image resource ${escapeXml(object.resourceName)} -->`;
  return `<image ${rectAttrs(object.bounds)} href="${imageHref(object.resource, {})}" preserveAspectRatio="none"${transform(object.bounds, object.angle)} />`;
}

function code39Bars(value: string): string[] {
  const payload = `*${value.toUpperCase()}*`;
  if ([...payload].some((character) => !CODE39[character])) return [];
  const bars: string[] = [];
  [...payload].forEach((character, charIndex) => {
    const pattern = CODE39[character];
    [...pattern].forEach((width, index) => bars.push(...Array(width === 'w' ? 3 : 1).fill(index % 2 === 0 ? 'bar' : 'space')));
    if (charIndex !== payload.length - 1) bars.push('space');
  });
  return bars;
}

function renderBarcode(object: LbxBarcodeObject): string {
  if (object.protocol.toUpperCase() !== 'CODE39') return `<text x="${fmt(object.bounds.x)}" y="${fmt(object.bounds.y + object.bounds.height / 2)}" font-size="10">${escapeXml(object.value)}</text>`;
  const bars = code39Bars(object.value);
  if (!bars.length) return `<text ${rectAttrs(object.bounds)}>${escapeXml(object.value)}</text>`;
  const unit = Math.max(0.2, object.barWidth);
  const total = bars.length * unit;
  const scale = Math.min(1, object.bounds.width / total);
  const barHeight = object.humanReadable ? object.bounds.height * 0.78 : object.bounds.height;
  let x = object.bounds.x + Math.max(0, (object.bounds.width - total * scale) / 2);
  const paths: string[] = [];
  for (const item of bars) {
    if (item === 'bar') paths.push(`<rect x="${fmt(x)}" y="${fmt(object.bounds.y)}" width="${fmt(unit * scale)}" height="${fmt(barHeight)}" />`);
    x += unit * scale;
  }
  const label = object.humanReadable ? `<text x="${fmt(object.bounds.x + object.bounds.width / 2)}" y="${fmt(object.bounds.y + object.bounds.height - 1)}" text-anchor="middle" font-family="monospace" font-size="${fmt(Math.min(10, object.bounds.height * 0.18))}">${escapeXml(object.value)}</text>` : '';
  return `<g${transform(object.bounds, object.angle)} fill="#000000">${paths.join('')}${label}</g>`;
}

function renderDateTime(object: LbxDateTimeObject): string {
  const text: LbxTextObject = { ...object, kind: 'text', value: object.value, fontSize: 9, color: '#000000', horizontalAlign: 'RIGHT', verticalAlign: 'CENTER' };
  return renderText(text, {});
}

function renderTable(object: LbxTableObject, options: SvgRenderOptions, renderObject: (item: LbxObject) => string): string {
  const lines: string[] = [`<rect ${rectAttrs(object.bounds)} fill="none" stroke="#000000" stroke-width="0.5"${transform(object.bounds, object.angle)} />`];
  for (const x of object.gridX) lines.push(`<line x1="${fmt(object.bounds.x + x)}" y1="${fmt(object.bounds.y)}" x2="${fmt(object.bounds.x + x)}" y2="${fmt(object.bounds.y + object.bounds.height)}" stroke="#000000" stroke-width="0.35" />`);
  for (const y of object.gridY) lines.push(`<line x1="${fmt(object.bounds.x)}" y1="${fmt(object.bounds.y + y)}" x2="${fmt(object.bounds.x + object.bounds.width)}" y2="${fmt(object.bounds.y + y)}" stroke="#000000" stroke-width="0.35" />`);
  for (const cell of object.cells) for (const child of cell.objects) lines.push(renderObject(child));
  return `<g data-lbx-table="${escapeXml(object.name)}">${lines.join('')}</g>`;
}

function renderOne(object: LbxObject, options: SvgRenderOptions): string {
  switch (object.kind) {
    case 'text': return renderText(object, options);
    case 'image': return object.resource ? `<image ${rectAttrs(object.bounds)} href="${imageHref(object.resource, options)}" preserveAspectRatio="none"${transform(object.bounds, object.angle)} />` : `<!-- missing image resource ${escapeXml(object.resourceName)} -->`;
    case 'barcode': return renderBarcode(object);
    case 'datetime': return renderDateTime(object);
    case 'table': return renderTable(object, options, (child) => renderOne(child, options));
    case 'unknown': return `<!-- unsupported LBX XML object ${escapeXml(object.tag)} at ${escapeXml(object.path)} -->${object.children.map((child) => renderOne(child, options)).join('')}`;
  }
}

function visitObjectExtents(object: LbxObject, current: { maxX: number; maxY: number }): void {
  current.maxX = Math.max(current.maxX, object.bounds.x + object.bounds.width);
  current.maxY = Math.max(current.maxY, object.bounds.y + object.bounds.height);
  if (object.kind === 'table') {
    for (const cell of object.cells) for (const child of cell.objects) visitObjectExtents(child, current);
  }
  for (const child of object.children) visitObjectExtents(child, current);
}

/**
 * LBX landscape documents store the tape width in paper.width and the label
 * length in paper.height. P-touch uses a very large sentinel length for
 * autoLength templates, so that value must not become the rendered canvas.
 */
function renderDimensions(document: LbxDocument): { width: number; height: number } {
  const landscape = document.paper.orientation?.toLowerCase() === 'landscape';
  if (!landscape) return { width: document.paper.width, height: document.paper.height };

  const autoLength = document.paper.attributes.autoLength?.toLowerCase() === 'true';
  if (!autoLength) return { width: document.paper.height, height: document.paper.width };

  const extent = { maxX: 0, maxY: 0 };
  for (const object of document.objects) visitObjectExtents(object, extent);
  const trailingMargin = Number.parseFloat(document.paper.attributes.marginBottom?.replace(/pt$/i, '') ?? '0') || 0;
  return {
    width: extent.maxX > 0 ? extent.maxX + trailingMargin : document.paper.width,
    height: document.paper.width,
  };
}

export function renderToSvg(document: LbxDocument, options: SvgRenderOptions = {}): string {
  const metadata = options.includeMetadata === false ? '' : `<metadata>${escapeXml(JSON.stringify({ files: document.sourceFiles, warnings: document.warnings }))}</metadata>`;
  const body = document.objects.map((object) => renderOne(object, options)).join('');
  const dimensions = renderDimensions(document);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(dimensions.width)}pt" height="${fmt(dimensions.height)}pt" viewBox="0 0 ${fmt(dimensions.width)} ${fmt(dimensions.height)}">${metadata}<rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

export { escapeXml };
