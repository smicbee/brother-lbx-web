import QRCode from 'qrcode';
import type {
  LbxBarcodeObject, LbxDateTimeObject, LbxDocument, LbxImageObject, LbxObject,
  LbxPointRect, LbxPolyObject, LbxResource, LbxTableObject, LbxTextObject,
  LbxTextRun, SvgRenderOptions,
} from './types.js';
import { layoutText } from './text-layout.js';

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


function clipId(object: LbxTextObject): string {
  let hash = 2166136261;
  for (const character of object.path) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `lbx-clip-${(hash >>> 0).toString(16)}`;
}

function renderText(object: LbxTextObject, options: SvgRenderOptions): string {
  const defaultFontSize = Math.max(0.01, options.defaultFontSize ?? 10);
  const layoutObject = (object.fontSize > 0 && object.runs.every((run) => run.fontSize > 0))
    ? object
    : {
        ...object,
        fontSize: object.fontSize > 0 ? object.fontSize : defaultFontSize,
        runs: object.runs.map((run) => ({ ...run, fontSize: run.fontSize > 0 ? run.fontSize : defaultFontSize })),
      };
  const layout = layoutText(layoutObject);
  const hasFrame = !['', 'NULL', 'NONE'].includes((object.frameStyle ?? 'NULL').toUpperCase()) && ((object.frameWidthX ?? 0) > 0 || (object.frameWidthY ?? 0) > 0);
  const hasFill = !['', 'NULL', 'NONE'].includes((object.brushStyle ?? 'NULL').toUpperCase());
  const frameWidth = Math.max(0, ((object.frameWidthX ?? 0) + (object.frameWidthY ?? 0)) / 2);
  const frameRect = hasFrame || hasFill
    ? `<rect x="${fmt(layout.bounds.x + (hasFrame ? frameWidth / 2 : 0))}" y="${fmt(layout.bounds.y + (hasFrame ? frameWidth / 2 : 0))}" width="${fmt(Math.max(0, layout.bounds.width - (hasFrame ? frameWidth : 0)))}" height="${fmt(Math.max(0, layout.bounds.height - (hasFrame ? frameWidth : 0)))}" fill="${hasFill ? escapeXml(object.brushColor ?? '#000000') : 'none'}"${hasFrame ? ` stroke="${escapeXml(object.frameColor ?? '#000000')}" stroke-width="${fmt(frameWidth)}" shape-rendering="crispEdges"` : ''}${transform(layout.bounds, object.angle)} />`
    : '';
  const anchor = textAnchor(object);
  const x = anchor === 'end' ? layout.bounds.x + layout.bounds.width : anchor === 'middle' ? layout.bounds.x + layout.bounds.width / 2 : layout.bounds.x;
  const lineHeights = layout.lines.map((line) => line.height);
  const lineSizes = layout.lines.map((line) => line.runs.length
    ? Math.max(...line.runs.map((run) => run.fontSize))
    : (object.fontSize || options.defaultFontSize || 10) * layout.scale);
  const totalHeight = layout.contentHeight;
  const firstSize = lineSizes[0] ?? object.fontSize ?? options.defaultFontSize ?? 10;
  const baseline = object.verticalAlign === 'TOP'
    ? layout.bounds.y + firstSize * 0.91
    : object.verticalAlign === 'BOTTOM'
      ? layout.bounds.y + layout.bounds.height - totalHeight + firstSize * 0.91
      : layout.bounds.y + (layout.bounds.height - totalHeight) / 2 + firstSize * 0.91;
  const text = layout.lines.map((line, lineIndex) => {
    const dy = lineIndex ? fmt(lineHeights[lineIndex - 1] ?? lineSizes[lineIndex - 1] ?? object.fontSize) : '0';
    if (!line.runs.length) return `<tspan x="${fmt(x)}" dy="${dy}"></tspan>`;
    return line.runs.map((run, runIndex) => {
      const position = runIndex === 0 ? ` x="${fmt(x)}" dy="${dy}"` : '';
      return `<tspan${position}${textRunAttributes(run, options)}>${escapeXml(run.value)}</tspan>`;
    }).join('');
  }).join('');
  const spacing = layout.charSpace ? ` letter-spacing="${fmt(layout.charSpace)}"` : '';
  const clipping = object.clipFrame ? ` clip-path="url(#${clipId(object)})"` : '';
  const definition = object.clipFrame ? `<defs><clipPath id="${clipId(object)}"><rect ${rectAttrs(layout.bounds)} /></clipPath></defs>` : '';
  return `${definition}${frameRect}<text data-lbx-effective-width="${fmt(layout.bounds.width)}" data-lbx-effective-height="${fmt(layout.bounds.height)}" data-lbx-layout-scale="${fmt(layout.scale)}" data-lbx-line-count="${layout.lines.length}" x="${fmt(x)}" y="${fmt(baseline)}" text-anchor="${anchor}"${spacing}${clipping}${transform(layout.bounds, object.angle)}>${text}</text>`;
}

function renderImage(object: LbxImageObject, options: SvgRenderOptions): string {
  if (!object.resource) return `<!-- missing image resource ${escapeXml(object.resourceName)} -->`;
  const mono = object.mono;
  const effect = object.effect;
  const monoAttributes = mono ? ` data-lbx-mono-operation="${escapeXml(mono.operationKind)}" data-lbx-mono-dither="${escapeXml(mono.ditherKind)}" data-lbx-mono-threshold="${fmt(mono.threshold)}" data-lbx-mono-gamma="${fmt(mono.gamma)}" data-lbx-mono-edge="${fmt(mono.ditherEdge)}" data-lbx-mono-red="${fmt(mono.red)}" data-lbx-mono-green="${fmt(mono.green)}" data-lbx-mono-blue="${fmt(mono.blue)}" data-lbx-mono-reverse="${mono.reverse ? '1' : '0'}" data-lbx-mono-proportions-reversed="${mono.proportionsReversed ? '1' : '0'}"` : '';
  const effectAttributes = effect ? ` data-lbx-image-effect="${escapeXml(effect.kind)}" data-lbx-image-brightness="${fmt(effect.brightness)}" data-lbx-image-contrast="${fmt(effect.contrast)}"` : '';
  let filterDefinition = '';
  let filter = '';
  if (mono?.operationKind.toUpperCase() === 'BINARY' && !mono.proportionsReversed) {
    let hash = 2166136261;
    for (const character of object.path) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    const id = `lbx-image-mono-${(hash >>> 0).toString(16)}`;
    const total = Math.max(1, mono.red + mono.green + mono.blue);
    const red = fmt(mono.red / total);
    const green = fmt(mono.green / total);
    const blue = fmt(mono.blue / total);
    filterDefinition = `<defs><filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${red} ${green} ${blue} 0 0 ${red} ${green} ${blue} 0 0 ${red} ${green} ${blue} 0 0 0 0 0 1 0" /></filter></defs>`;
    filter = ` filter="url(#${id})"`;
  }
  return `${filterDefinition}<image ${rectAttrs(object.bounds)} href="${imageHref(object.resource, options)}" preserveAspectRatio="none"${monoAttributes}${effectAttributes}${filter}${transform(object.bounds, object.angle)} />`;
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

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function storedCalendarParts(object: LbxDateTimeObject): CalendarParts | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(object.date.trim());
  if (!match) return undefined;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: object.hour, minute: object.minute,
  };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) return undefined;
  return parts;
}

function printCalendarParts(options: SvgRenderOptions): CalendarParts | undefined {
  const instant = options.printDate === undefined ? new Date() : new Date(options.printDate);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    hourCycle: 'h23', ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const values = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute),
  };
}

function applyDateAddition(parts: CalendarParts, object: LbxDateTimeObject): CalendarParts {
  if (!object.addition || !object.addPeriod) return parts;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  switch (object.units.toUpperCase()) {
    case 'YEARS': date.setUTCFullYear(date.getUTCFullYear() + object.addPeriod); break;
    case 'MONTHS': date.setUTCMonth(date.getUTCMonth() + object.addPeriod); break;
    case 'HOURS': date.setUTCHours(date.getUTCHours() + object.addPeriod); break;
    case 'MINUTES': date.setUTCMinutes(date.getUTCMinutes() + object.addPeriod); break;
    default: date.setUTCDate(date.getUTCDate() + object.addPeriod); break;
  }
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(),
  };
}

function localizedPart(parts: CalendarParts, locale: SvgRenderOptions['locale'], key: 'weekday' | 'month', width: 'long' | 'short'): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return new Intl.DateTimeFormat(locale, { [key]: width, timeZone: 'UTC' }).format(date);
}

function longDate(parts: CalendarParts, locale: SvgRenderOptions['locale']): string {
  const resolved = new Intl.DateTimeFormat(locale).resolvedOptions().locale.toLowerCase();
  const weekday = localizedPart(parts, locale, 'weekday', 'long');
  const month = localizedPart(parts, locale, 'month', 'long');
  if (resolved.startsWith('de')) return `${weekday}, ${parts.day}. ${month} ${parts.year}`;
  if (resolved.startsWith('en')) return `${weekday}, ${parts.day} ${month}, ${parts.year}`;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(date);
}

function formatBrotherDate(parts: CalendarParts, format: string, locale: SvgRenderOptions['locale']): string {
  const yyyy = pad(parts.year, 4);
  const yy = pad(parts.year % 100);
  const mm = pad(parts.month);
  const dd = pad(parts.day);
  const monthShort = localizedPart(parts, locale, 'month', 'short');
  const monthLong = localizedPart(parts, locale, 'month', 'long');
  switch (Number.parseInt(format, 10)) {
    case 7: return `${yyyy}/${mm}/${dd}`;
    case 8: return `${yy}/${mm}/${dd}`;
    case 9: return `${parts.month}/${parts.day}/${yy}`;
    case 10: return `${mm}/${dd}/${yy}`;
    case 11: return `${monthShort} ${parts.day}, ${yyyy}`;
    case 12: return `${monthLong} ${parts.day}, ${yyyy}`;
    case 13: return `${parts.day} ${monthLong} '${yy}`;
    case 14: return `${parts.day} ${monthShort} '${yy}`;
    case 15: return `${yyyy}-${mm}-${dd}`;
    case 16: return `${yy}-${mm}-${dd}`;
    case 17: return `${parts.month}/${parts.day}/${yyyy}`;
    case 18: return `${dd}/${mm}/${yyyy}`;
    case 19: return `${dd}/${mm}/${yy}`;
    case 20: return `${dd}-${mm}-${yyyy}`;
    case 21: return `${dd}-${mm}-${yy}`;
    case 22: return `${dd}.${mm}.${yyyy}`;
    case 23: return `${dd}.${mm}.${yy}`;
    case 25: return `${parts.day}.${parts.month}.${yyyy}`;
    case 50: return `${yyyy}.${parts.month}.${parts.day}`;
    case 51: return `${yy}.${parts.month}.${parts.day}`;
    case 52: return `${yyyy}.${parts.month}`;
    case 53: return `${yy}.${parts.month}`;
    case 24:
    default: return longDate(parts, locale);
  }
}

/** Format an LBX DateTime object with the native b-PAC date/atPrint semantics. */
export function formatBrotherDateTime(object: LbxDateTimeObject, options: SvgRenderOptions = {}): string {
  const source = object.atPrint ? printCalendarParts(options) : storedCalendarParts(object);
  if (!source) return object.value;
  const parts = applyDateAddition(source, object);
  const mode = object.mode.toUpperCase();
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (mode === 'TIME') return time;
  const date = formatBrotherDate(parts, object.format, options.locale);
  return mode.includes('TIME') ? `${date} ${time}` : date;
}

function renderDateTime(object: LbxDateTimeObject, options: SvgRenderOptions): string {
  const value = formatBrotherDateTime(object, options);
  const run: LbxTextRun = {
    value, fontFamily: object.fontFamily, fontSize: object.fontSize,
    fontWeight: object.fontWeight, italic: object.italic, underline: object.underline,
    strikeout: object.strikeout, color: object.color,
  };
  const text: LbxTextObject = {
    ...object, kind: 'text', value, runs: [run],
    horizontalAlign: object.horizontalAlign, verticalAlign: object.verticalAlign,
    control: object.fixedFrame ? 'FIXEDFRAME' : 'FREE', clipFrame: false,
    shrink: object.fixedFrame, autoLineFeed: false, charSpace: object.charSpace,
    lineSpace: 0, vertical: object.vertical,
  };
  return renderText(text, options);
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
    case 'image': return renderImage(object, options);
    case 'barcode': return renderBarcode(object);
    case 'datetime': return renderDateTime(object, options);
    case 'poly': return renderPoly(object);
    case 'table': return renderTable(object, options, (child) => renderOne(child, options));
    case 'unknown': return `<!-- unsupported LBX XML object ${escapeXml(object.tag)} at ${escapeXml(object.path)} -->${object.children.map((child) => renderOne(child, options)).join('')}`;
  }
}

function visitObjectExtents(object: LbxObject, current: { maxX: number; maxY: number }): void {
  const bounds = object.kind === 'text' ? layoutText(object).bounds : object.bounds;
  const radians = object.angle * Math.PI / 180;
  if (radians) {
    const halfWidth = Math.abs(bounds.width * Math.cos(radians)) / 2 + Math.abs(bounds.height * Math.sin(radians)) / 2;
    const halfHeight = Math.abs(bounds.width * Math.sin(radians)) / 2 + Math.abs(bounds.height * Math.cos(radians)) / 2;
    current.maxX = Math.max(current.maxX, bounds.x + bounds.width / 2 + halfWidth);
    current.maxY = Math.max(current.maxY, bounds.y + bounds.height / 2 + halfHeight);
  } else {
    current.maxX = Math.max(current.maxX, bounds.x + bounds.width);
    current.maxY = Math.max(current.maxY, bounds.y + bounds.height);
  }
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
