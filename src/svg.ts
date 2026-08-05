import QRCode from 'qrcode';
import type {
  LbxBarcodeObject, LbxDateTimeObject, LbxDocument, LbxImageObject, LbxObject,
  LbxPointRect, LbxPolyObject, LbxResource, LbxTableObject, LbxTextObject,
  LbxTextRun, SvgRenderOptions,
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

const MONOCHROME_EMOJI = new Map<string, string>([
  ['☕', '☕︎'], ['🔥', '♨'], ['❤', '♥'], ['✅', '✓'], ['☑', '☑︎'], ['✔', '✓'], ['❌', '✕'], ['❎', '✕'],
  ['⭐', '★'], ['🌟', '★'], ['💫', '✦'], ['✨', '✦'], ['💡', '✦'], ['⚠', '⚠︎'], ['ℹ', 'ⓘ'], ['❓', '?'], ['❗', '!'],
  ['😀', '☺'], ['😃', '☺'], ['😄', '☺'], ['😁', '☺'], ['😊', '☺'], ['🙂', '☺'], ['😉', '☺'], ['😍', '♥'],
  ['😢', '☹'], ['😭', '☹'], ['☹', '☹︎'], ['😞', '☹'], ['😡', '☹'], ['😠', '☹'],
  ['👍', '✓'], ['👎', '✕'], ['👌', '○'], ['👏', '✦'], ['🙏', '◇'],
  ['🎉', '✦'], ['🎊', '✦'], ['🎁', '□'], ['📦', '□'], ['📍', '●'], ['🚀', '↑'],
  ['🔴', '●'], ['🟠', '●'], ['🟡', '●'], ['🟢', '●'], ['🔵', '●'], ['🟣', '●'], ['🟤', '●'], ['⚫', '●'], ['⚪', '○'],
  ['📞', '☎'], ['☎', '☎︎'], ['✉', '✉︎'], ['📧', '✉︎'], ['🔒', '▣'], ['🔓', '□'], ['⚙', '⚙︎'], ['🛒', '⌑'],
  ['➡', '→'], ['⬅', '←'], ['⬆', '↑'], ['⬇', '↓'], ['↗', '↗︎'], ['↘', '↘︎'], ['↙', '↙︎'], ['↖', '↖︎'],
]);

const EMOJI_SEQUENCE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?)*)/gu;

function monochromeEmojiText(value: string): string {
  return value.replace(EMOJI_SEQUENCE, (sequence) => {
    const normalized = sequence.replace(/[\uFE0E\uFE0F]/gu, '').replace(/\p{Emoji_Modifier}/gu, '');
    const mapped = MONOCHROME_EMOJI.get(normalized);
    if (mapped) return mapped;
    if (/^[#*0-9]\u20E3$/u.test(normalized)) return `[${normalized[0]}]`;
    if (/^\p{Regional_Indicator}{2}$/u.test(normalized)) return '⚑';
    const codePoints = [...normalized];
    if (codePoints.length === 1 && (codePoints[0]?.codePointAt(0) ?? 0) <= 0x2bff) return `${normalized}︎`;
    return '◇';
  });
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
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(triple >>> 18) & 63] ?? '';
    encoded += alphabet[(triple >>> 12) & 63] ?? '';
    encoded += second === undefined ? '=' : (alphabet[(triple >>> 6) & 63] ?? '');
    encoded += third === undefined ? '=' : (alphabet[triple & 63] ?? '');
  }
  return encoded;
}

function imageHref(resource: LbxResource, options: SvgRenderOptions): string {
  if (options.imageResolver) return options.imageResolver(resource);
  return `data:${resource.mime};base64,${base64(resource.bytes)}`;
}

function textAnchor(object: LbxTextObject): 'start' | 'middle' | 'end' {
  if (object.horizontalAlign === 'RIGHT') return 'end';
  if (object.horizontalAlign === 'CENTER') return 'middle';
  return 'start';
}

function textDecoration(run: LbxTextRun): string | undefined {
  const values = [];
  if (run.underline) values.push('underline');
  if (run.strikeout) values.push('line-through');
  return values.length ? values.join(' ') : undefined;
}

function textRunAttributes(run: LbxTextRun, options: SvgRenderOptions): string {
  const family = escapeXml(run.fontFamily || options.fontFamily || 'Arial');
  const decoration = textDecoration(run);
  return ` font-family="${family}" font-size="${fmt(run.fontSize || options.defaultFontSize || 10)}" font-weight="${fmt(run.fontWeight)}"${run.italic ? ' font-style="italic"' : ''}${decoration ? ` text-decoration="${decoration}"` : ''} fill="${escapeXml(run.color)}"`;
}

function splitTextRuns(object: LbxTextObject): LbxTextRun[][] {
  const lines: LbxTextRun[][] = [[]];
  for (const run of object.runs) {
    const parts = monochromeEmojiText(run.value).split(/\r\n|\r|\n/);
    parts.forEach((part, index) => {
      if (part) lines[lines.length - 1]?.push({ ...run, value: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines.length ? lines : [[{ ...object, value: object.value }]];
}

function estimatedGlyphWidth(character: string, fontSize: number): number {
  if (/^[\u200D\uFE0E\uFE0F]$/u.test(character) || /^\p{Mark}$/u.test(character)) return 0;
  if (/\s/u.test(character)) return fontSize * 0.33;
  if (/[\u2190-\u27BF]/u.test(character)) return fontSize * 0.9;
  if (/[il1|.,'`:;]/u.test(character)) return fontSize * 0.28;
  if (character === 'I') return fontSize * 0.35;
  if (/[MW@%#&]/u.test(character)) return fontSize * 0.85;
  if (/[A-Z]/u.test(character)) return fontSize * 0.664;
  if (/[0-9]/u.test(character)) return fontSize * 0.56;
  if (/[a-z]/u.test(character)) return fontSize * 0.528;
  return fontSize * 0.6;
}

/**
 * AUTOLEN text frames are resized by P-touch Editor after their text changes,
 * but an edited in-memory LBX still carries the old frame rectangle. Estimate
 * the rendered line width so continuous-tape output can grow and shrink before
 * a browser or rasterizer has laid out the SVG text. The one-decimal rounding
 * matches the precision used by Brother's stored point geometry.
 */
function autoLengthTextWidth(object: LbxTextObject): number | undefined {
  if (object.control.toUpperCase() !== 'AUTOLEN' || object.vertical || object.angle) return undefined;
  const widths = splitTextRuns(object).map((line) => {
    let width = 0;
    let characters = 0;
    for (const run of line) {
      const fontSize = run.fontSize || object.fontSize || 10;
      const glyphs = [...run.value];
      characters += glyphs.length;
      let runWidth = glyphs.reduce((sum, character) => sum + estimatedGlyphWidth(character, fontSize), 0);
      if (run.fontWeight >= 600) runWidth *= 1.03;
      if (run.italic) runWidth *= 1.02;
      width += runWidth;
    }
    width += Math.max(0, characters - 1) * object.charSpace;
    return width;
  });
  return Math.round(Math.max(0, ...widths) * 10) / 10;
}

function lineFontSize(line: LbxTextRun[], object: LbxTextObject, options: SvgRenderOptions): number {
  return Math.max(...line.map((run) => run.fontSize), object.fontSize || options.defaultFontSize || 10);
}

function textFirstBaseline(object: LbxTextObject, lineSizes: number[], lineHeights: number[]): number {
  const totalHeight = lineSizes.length === 1
    ? lineSizes[0] ?? object.fontSize
    : (lineHeights.slice(0, -1).reduce((sum, height) => sum + height, 0) + (lineSizes.at(-1) ?? object.fontSize));
  const firstSize = lineSizes[0] ?? object.fontSize;
  if (object.verticalAlign === 'TOP') return object.bounds.y + firstSize * 0.8;
  if (object.verticalAlign === 'BOTTOM') return object.bounds.y + object.bounds.height - totalHeight + firstSize * 0.8;
  return object.bounds.y + (object.bounds.height - totalHeight) / 2 + firstSize * 0.85;
}

function clipId(object: LbxTextObject): string {
  let hash = 2166136261;
  for (const character of object.path) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `lbx-clip-${(hash >>> 0).toString(16)}`;
}

function renderText(object: LbxTextObject, options: SvgRenderOptions): string {
  const lines = splitTextRuns(object);
  const anchor = textAnchor(object);
  const x = anchor === 'end' ? object.bounds.x + object.bounds.width : anchor === 'middle' ? object.bounds.x + object.bounds.width / 2 : object.bounds.x;
  const lineSizes = lines.map((line) => lineFontSize(line, object, options));
  const lineHeights = lineSizes.map((size) => size * (1 + object.lineSpace / 100));
  const baseline = textFirstBaseline(object, lineSizes, lineHeights);
  const text = lines.map((line, lineIndex) => line.map((run, runIndex) => {
    const position = runIndex === 0 ? ` x="${fmt(x)}" dy="${lineIndex ? fmt(lineHeights[lineIndex - 1] ?? lineSizes[lineIndex - 1] ?? object.fontSize) : '0'}"` : '';
    return `<tspan${position}${textRunAttributes(run, options)}>${escapeXml(run.value)}</tspan>`;
  }).join('')).join('');
  const spacing = object.charSpace ? ` letter-spacing="${fmt(object.charSpace)}"` : '';
  const clipping = object.clipFrame ? ` clip-path="url(#${clipId(object)})"` : '';
  const definition = object.clipFrame ? `<defs><clipPath id="${clipId(object)}"><rect ${rectAttrs(object.bounds)} /></clipPath></defs>` : '';
  return `${definition}<text x="${fmt(x)}" y="${fmt(baseline)}" text-anchor="${anchor}"${spacing}${clipping}${transform(object.bounds, object.angle)}>${text}</text>`;
}

function renderImage(object: LbxImageObject): string {
  if (!object.resource) return `<!-- missing image resource ${escapeXml(object.resourceName)} -->`;
  return `<image ${rectAttrs(object.bounds)} href="${imageHref(object.resource, {})}" preserveAspectRatio="none"${transform(object.bounds, object.angle)} />`;
}

interface Code39Element { bar: boolean; width: number }

function code39WideRatio(raw: string): number {
  const [narrowRaw, wideRaw] = raw.split(':');
  const narrow = Number.parseFloat(narrowRaw ?? '');
  const wide = Number.parseFloat(wideRaw ?? '');
  const ratio = wide / narrow;
  return Number.isFinite(ratio) && ratio >= 1.5 && ratio <= 4 ? ratio : 3;
}

function code39Elements(value: string, wideRatio: number): Code39Element[] {
  const payload = `*${value.toUpperCase()}*`;
  if ([...payload].some((character) => !CODE39[character])) return [];
  const elements: Code39Element[] = [];
  [...payload].forEach((character, charIndex) => {
    const pattern = CODE39[character];
    [...pattern].forEach((width, index) => elements.push({ bar: index % 2 === 0, width: width === 'w' ? wideRatio : 1 }));
    if (charIndex !== payload.length - 1) elements.push({ bar: false, width: 1 });
  });
  return elements;
}

function renderBarcode(object: LbxBarcodeObject): string {
  if (object.protocol.toUpperCase() === 'QRCODE') return renderQrCode(object);
  if (object.protocol.toUpperCase() !== 'CODE39') return `<!-- unsupported barcode protocol ${escapeXml(object.protocol)} -->`;
  const elements = code39Elements(object.value, code39WideRatio(object.barRatio));
  if (!elements.length) return `<text ${rectAttrs(object.bounds)}>${escapeXml(object.value)}</text>`;
  const unit = Math.max(0.2, object.barWidth);
  const total = elements.reduce((sum, element) => sum + element.width * unit, 0);
  const scale = Math.min(1, object.bounds.width / total);
  const barHeight = object.humanReadable ? object.bounds.height * 0.78 : object.bounds.height;
  let x = object.bounds.x + Math.max(0, (object.bounds.width - total * scale) / 2);
  const paths: string[] = [];
  for (const element of elements) {
    const width = element.width * unit * scale;
    if (element.bar) paths.push(`<rect x="${fmt(x)}" y="${fmt(object.bounds.y)}" width="${fmt(width)}" height="${fmt(barHeight)}" />`);
    x += width;
  }
  const label = object.humanReadable ? `<text x="${fmt(object.bounds.x + object.bounds.width / 2)}" y="${fmt(object.bounds.y + object.bounds.height - 1)}" text-anchor="middle" font-family="monospace" font-size="${fmt(Math.min(10, object.bounds.height * 0.18))}">${escapeXml(object.value)}</text>` : '';
  return `<g${transform(object.bounds, object.angle)} fill="#000000">${paths.join('')}${label}</g>`;
}

function qrErrorCorrectionLevel(raw: string): 'L' | 'M' | 'Q' | 'H' {
  const normalized = raw.trim().toUpperCase();
  if (normalized === '7%' || normalized === 'L') return 'L';
  if (normalized === '25%' || normalized === 'Q') return 'Q';
  if (normalized === '30%' || normalized === 'H') return 'H';
  return 'M';
}

interface QrModules {
  size: number;
  data: Uint8Array;
  get(row: number, column: number): number;
}

type QrMaskPattern = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
const QR_MASK_PATTERNS: readonly QrMaskPattern[] = [0, 1, 2, 3, 4, 5, 6, 7];

function brotherQrPenalty(modules: QrModules): number {
  const size = modules.size;
  let penalty = 0;

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const dark = modules.get(row, column)
        + modules.get(row + 1, column)
        + modules.get(row, column + 1)
        + modules.get(row + 1, column + 1);
      if (dark === 0 || dark === 4) penalty += 3;
    }
  }

  const linePenalty = (line: number[]): number => {
    const runs: number[] = [];
    let previous = line[0] ?? 0;
    let length = 1;
    if (previous) runs.push(-1);
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] !== previous) {
        runs.push(length);
        previous = line[index] ?? 0;
        length = 1;
      } else {
        length += 1;
      }
    }
    runs.push(length);

    let result = 0;
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index] ?? 0;
      if (run >= 5) result += run - 2;
      if ((index & 1) && index >= 3 && index < runs.length - 2 && run % 3 === 0) {
        const unit = run / 3;
        if (
          runs[index - 2] === unit
          && runs[index - 1] === unit
          && runs[index + 1] === unit
          && runs[index + 2] === unit
          && (index === 3 || (runs[index - 3] ?? 0) >= 4 * unit || index + 4 >= runs.length || (runs[index + 3] ?? 0) >= 4 * unit)
        ) result += 40;
      }
    }
    return result;
  };

  for (let row = 0; row < size; row += 1) {
    penalty += linePenalty(Array.from({ length: size }, (_, column) => modules.get(row, column)));
  }
  for (let column = 0; column < size; column += 1) {
    penalty += linePenalty(Array.from({ length: size }, (_, row) => modules.get(row, column)));
  }

  let dark = 0;
  for (const value of modules.data) dark += value;
  const percentage = Math.floor((200 * dark + size * size) / (size * size) / 2);
  return penalty + Math.floor(Math.abs(percentage - 50) / 5) * 10;
}

export function selectBrotherQrMask(
  payload: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H',
  version?: number,
): QrMaskPattern {
  let selected: QrMaskPattern = 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (const maskPattern of QR_MASK_PATTERNS) {
    const qr = QRCode.create(payload, { errorCorrectionLevel, version, maskPattern });
    const penalty = brotherQrPenalty(qr.modules);
    if (penalty < minimum) {
      minimum = penalty;
      selected = maskPattern;
    }
  }
  return selected;
}

function renderQrCode(object: LbxBarcodeObject): string {
  if (!object.qrCode || object.qrCode.model !== 2) return `<!-- unsupported QR code model -->`;
  const payload = object.value.replaceAll('\\D\\A', '\r\n');
  if (!payload) return `<!-- empty QR code payload -->`;
  const errorCorrectionLevel = qrErrorCorrectionLevel(object.qrCode.errorCorrectionLevel);
  let qr: ReturnType<typeof QRCode.create>;
  try {
    const maskPattern = selectBrotherQrMask(payload, errorCorrectionLevel, object.qrCode.version);
    qr = QRCode.create(payload, {
      errorCorrectionLevel,
      version: object.qrCode.version,
      maskPattern,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot contain this amount of data')) {
      return `<!-- QR code payload does not fit configured version -->`;
    }
    throw error;
  }
  const quietModules = object.qrCode.margin ? 1 : 0;
  const configuredCell = object.qrCode.cellSize > 0 ? object.qrCode.cellSize : 1;
  const maximumCell = Math.min(
    object.bounds.width / (qr.modules.size + quietModules * 2),
    object.bounds.height / (qr.modules.size + quietModules * 2),
  );
  const cell = Math.min(configuredCell, maximumCell);
  const size = (qr.modules.size + quietModules * 2) * cell;
  const startX = object.bounds.x + (object.bounds.width - size) / 2 + quietModules * cell;
  const startY = object.bounds.y + (object.bounds.height - size) / 2 + quietModules * cell;
  const modules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column)) modules.push(`M${fmt(startX + column * cell)} ${fmt(startY + row * cell)}h${fmt(cell)}v${fmt(cell)}h-${fmt(cell)}z`);
    }
  }
  return `<path d="${modules.join('')}" fill="#000000"${transform(object.bounds, object.angle)} />`;
}

function renderDateTime(object: LbxDateTimeObject): string {
  const run: LbxTextRun = {
    value: object.value, fontSize: 9, fontWeight: 400, italic: false,
    underline: false, strikeout: false, color: '#000000',
  };
  const text: LbxTextObject = {
    ...object, kind: 'text', value: object.value, fontSize: 9, fontWeight: 400,
    italic: false, underline: false, strikeout: false, color: '#000000',
    horizontalAlign: 'RIGHT', verticalAlign: 'CENTER', control: 'FREE',
    clipFrame: false, shrink: false, autoLineFeed: false, charSpace: 0,
    lineSpace: 0, vertical: false, runs: [run],
  };
  return renderText(text, {});
}

function renderPoly(object: LbxPolyObject): string {
  if (!object.points.length) return '';
  return `<polyline points="${object.points.map((point) => `${fmt(point.x)},${fmt(point.y)}`).join(' ')}" fill="none" stroke="${escapeXml(object.stroke)}" stroke-width="${fmt(object.strokeWidth)}"${transform(object.bounds, object.angle)} />`;
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
    case 'poly': return renderPoly(object);
    case 'table': return renderTable(object, options, (child) => renderOne(child, options));
    case 'unknown': return `<!-- unsupported LBX XML object ${escapeXml(object.tag)} at ${escapeXml(object.path)} -->${object.children.map((child) => renderOne(child, options)).join('')}`;
  }
}

function visitObjectExtents(object: LbxObject, current: { maxX: number; maxY: number }): void {
  const contentWidth = object.kind === 'text' ? autoLengthTextWidth(object) : undefined;
  current.maxX = Math.max(current.maxX, object.bounds.x + (contentWidth ?? object.bounds.width));
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
