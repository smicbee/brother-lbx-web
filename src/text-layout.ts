import type { LbxPointRect, LbxTextObject, LbxTextRun } from './types.js';

export interface TextLayoutLine {
  runs: LbxTextRun[];
  width: number;
  inkHeight: number;
  height: number;
}

export interface TextLayoutResult {
  bounds: LbxPointRect;
  originalBounds: LbxPointRect;
  lines: TextLayoutLine[];
  scale: number;
  charSpace: number;
  contentWidth: number;
  contentHeight: number;
  overflow: boolean;
}

const EMOJI_MAP = new Map<string, string>([
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

const ARIAL_ASCII_ADVANCES = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
] as const;

// Arial Bold/Liberation Sans Bold has materially different advances from the
// regular face. Applying a small synthetic weight multiplier to regular Arial
// under-measures real bold labels and can let FIXEDFRAME ink escape its frame.
const ARIAL_BOLD_ASCII_ADVANCES = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
] as const;

// Carlito is metrically compatible with Calibri and is used by the Node
// renderer when Calibri itself is unavailable.
const CALIBRI_ASCII_ADVANCES = [
  226, 326, 401, 498, 507, 715, 682, 221, 303, 303, 498, 498, 250, 306, 252, 386,
  507, 507, 507, 507, 507, 507, 507, 507, 507, 507, 268, 268, 498, 498, 498, 463,
  894, 579, 544, 533, 615, 488, 459, 631, 623, 252, 319, 520, 420, 855, 646, 662,
  517, 673, 543, 459, 487, 642, 567, 890, 519, 487, 468, 307, 386, 307, 498, 498,
  291, 479, 525, 423, 525, 498, 305, 471, 525, 230, 239, 455, 230, 799, 525, 527,
  525, 525, 349, 391, 335, 525, 452, 715, 433, 453, 395, 314, 460, 314, 498,
] as const;

export function monochromeEmojiText(value: string): string {
  return value.replace(EMOJI_SEQUENCE, (sequence) => {
    const normalized = sequence.replace(/[\uFE0E\uFE0F]/gu, '').replace(/\p{Emoji_Modifier}/gu, '');
    const mapped = EMOJI_MAP.get(normalized);
    if (mapped) return mapped;
    if (/^[#*0-9]\u20E3$/u.test(normalized)) return `[${normalized[0]}]`;
    if (/^\p{Regional_Indicator}{2}$/u.test(normalized)) return '⚑';
    const codePoints = [...normalized];
    if (codePoints.length === 1 && (codePoints[0]?.codePointAt(0) ?? 0) <= 0x2bff) return `${normalized}︎`;
    return '◇';
  });
}

/** Split by user-perceived characters where the platform provides Intl.Segmenter. */
export function graphemes(value: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((item) => item.segment);
  const result: string[] = [];
  for (const codePoint of Array.from(value)) {
    if (/^[\u0300-\u036f\uFE00-\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]$/u.test(codePoint) && result.length) result[result.length - 1] += codePoint;
    else result.push(codePoint);
  }
  return result;
}

function asciiMetricCodePoint(character: string): number | undefined {
  const normalized = character.normalize('NFD');
  const parts = [...normalized];
  const codePoint = parts[0]?.codePointAt(0);
  if (codePoint === undefined || codePoint < 0x20 || codePoint > 0x7e) return undefined;
  return parts.slice(1).every((part) => /^\p{Mark}$/u.test(part)) ? codePoint : undefined;
}

/** Deterministic fallback metric shared by wrapping, sizing, and SVG layout. */
export function estimatedGlyphWidth(character: string, fontSize: number, fontFamily = 'Arial', fontWeight = 400): number {
  if (/^[\u200D\uFE0E\uFE0F]$/u.test(character) || /^\p{Mark}$/u.test(character)) return 0;
  // Arial-compatible advances in 1/1000 em. Liberation Sans deliberately
  // uses the same metrics, so this table keeps wrapping deterministic in
  // Node while matching b-PAC/GDI far more closely than broad glyph classes.
  // Canonically decomposable Latin letters reuse their ASCII base advance.
  const codePoint = asciiMetricCodePoint(character) ?? character.codePointAt(0) ?? -1;
  const arialCompatible = /^(?:Arial|Liberation Sans)$/i.test(fontFamily);
  const asciiAdvances = arialCompatible
    ? (fontWeight >= 600 ? ARIAL_BOLD_ASCII_ADVANCES : ARIAL_ASCII_ADVANCES)
    : /^(?:Calibri|Carlito)$/i.test(fontFamily)
      ? CALIBRI_ASCII_ADVANCES
      : undefined;
  if (asciiAdvances && codePoint >= 0x20 && codePoint <= 0x7e) return fontSize * (asciiAdvances[codePoint - 0x20] ?? 600) / 1000;
  // Browser SVG engines can resolve a broad Unicode fallback behind the
  // Arial alias. Unknown bold glyphs vary from roughly 0.8em (Greek) to more
  // than 1.1em (numero sign), so a narrow generic 0.6em estimate is unsafe.
  if (arialCompatible && fontWeight >= 600) return fontSize * 1.2;
  if (/\s/u.test(character)) return fontSize * 0.278;
  if (/[\u2190-\u27BF]/u.test(character)) return fontSize * 0.9;
  if (/[il1|.,'`:;]/u.test(character)) return fontSize * 0.28;
  if (character === 'I') return fontSize * 0.35;
  if (/[MW@%#&]/u.test(character)) return fontSize * 0.85;
  if (/[A-Z]/u.test(character)) return fontSize * 0.664;
  if (/[0-9]/u.test(character)) return fontSize * 0.56;
  if (/[a-z]/u.test(character)) return fontSize * 0.528;
  return fontSize * 0.6;
}

interface Glyph {
  value: string;
  run: LbxTextRun;
}

function runGlyphs(run: LbxTextRun): Glyph[] {
  return graphemes(monochromeEmojiText(run.value)).map((value) => ({ value, run }));
}

function runWidth(glyphs: Glyph[], fontScale = 1): number {
  let width = 0;
  for (const glyph of glyphs) {
    const fontSize = Math.max(0.01, glyph.run.fontSize || 10) * Math.max(0.01, fontScale);
    let advance = estimatedGlyphWidth(glyph.value, fontSize, glyph.run.fontFamily, glyph.run.fontWeight);
    // Known Arial-compatible ASCII/Latin-diacritic glyphs select a real
    // bold table. Other Unicode glyphs still need a conservative weight
    // fallback or their raster ink can escape narrow FIXEDFRAME objects.
    if (glyph.run.fontWeight >= 600) {
      const arialCompatible = /^(?:Arial|Liberation Sans)$/i.test(glyph.run.fontFamily ?? 'Arial');
      const hasMeasuredBoldAdvance = arialCompatible && asciiMetricCodePoint(glyph.value) !== undefined;
      if (!hasMeasuredBoldAdvance && !arialCompatible) advance *= 1.03;
    }
    if (glyph.run.italic) advance *= 1.02;
    width += advance;
  }
  return width;
}

function mergeRuns(glyphs: Glyph[]): LbxTextRun[] {
  const runs: LbxTextRun[] = [];
  for (const glyph of glyphs) {
    const previous = runs.at(-1);
    if (previous
      && previous.fontFamily === glyph.run.fontFamily
      && previous.fontSize === glyph.run.fontSize
      && previous.fontWeight === glyph.run.fontWeight
      && previous.italic === glyph.run.italic
      && previous.underline === glyph.run.underline
      && previous.strikeout === glyph.run.strikeout
      && previous.color === glyph.run.color) {
      previous.value += glyph.value;
    } else runs.push({ ...glyph.run, value: glyph.value });
  }
  return runs;
}

function lineGlyphs(line: LbxTextRun[]): Glyph[] {
  return line.flatMap((run) => runGlyphs(run));
}

function lineWidth(line: LbxTextRun[], charSpace: number, fontScale = 1): number {
  const glyphs = lineGlyphs(line);
  return Math.max(0, runWidth(glyphs, fontScale) + Math.max(0, glyphs.length - 1) * charSpace * fontScale);
}

function lineMetrics(line: LbxTextRun[], object: LbxTextObject, fallbackScale = 1): { inkHeight: number; height: number } {
  const size = line.length
    ? Math.max(...line.map((run) => Math.max(0.01, run.fontSize || object.fontSize * fallbackScale || 10 * fallbackScale)))
    : Math.max(0.01, (object.fontSize || 10) * fallbackScale);
  // Native b-PAC reports a 22.4 pt LONGTEXT frame for two 10 pt Arial lines:
  // its zero-spacing line box is therefore 1.12 em. lineSpace is additional
  // percentage-of-em leading, not a replacement for the font's own leading.
  const lineBox = size * 1.12;
  return { inkHeight: lineBox, height: Math.max(0, lineBox + size * object.lineSpace / 100) };
}

function splitExplicitLines(object: LbxTextObject): LbxTextRun[][] {
  const lines: LbxTextRun[][] = [[]];
  for (const run of object.runs.length ? object.runs : [{ ...object, value: object.value }]) {
    const parts = monochromeEmojiText(run.value).split(/\r\n|\r|\n/);
    parts.forEach((part, index) => {
      if (part) lines.at(-1)?.push({ ...run, value: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines;
}

function wrapLine(line: LbxTextRun[], width: number, charSpace: number, fontScale = 1): LbxTextRun[][] {
  if (!(width > 0) || !line.length) return [line];
  const glyphs = lineGlyphs(line);
  const output: Glyph[][] = [];
  let current: Glyph[] = [];
  let lastBreak = -1;
  const flush = () => {
    while (current.at(-1)?.value && /\s/u.test(current.at(-1)?.value ?? '')) current.pop();
    if (current.length) output.push(current);
    current = [];
    lastBreak = -1;
  };
  for (const glyph of glyphs) {
    const candidate = [...current, glyph];
    const candidateWidth = runWidth(candidate, fontScale) + Math.max(0, candidate.length - 1) * charSpace * fontScale;
    if (current.length && candidateWidth > width) {
      if (lastBreak >= 0) {
        const remainder = current.splice(lastBreak + 1);
        while (current.at(-1)?.value && /\s/u.test(current.at(-1)?.value ?? '')) current.pop();
        if (current.length) output.push(current);
        current = remainder.filter((item) => !/^\s$/u.test(item.value));
        lastBreak = -1;
      } else {
        flush();
      }
      if (current.length) {
        const retry = runWidth([...current, glyph], fontScale) + Math.max(0, current.length) * charSpace * fontScale;
        if (retry > width) flush();
      }
    }
    // A separator that caused wrapping belongs to neither visual line. Keep
    // intentional leading whitespace on the first line, but never create a
    // whitespace-only continuation line.
    if (!current.length && output.length && /\s/u.test(glyph.value)) continue;
    // Native b-PAC treats an ASCII hyphen as a visible line-break
    // opportunity: keep the hyphen on the preceding line and continue after it.
    if (/\s/u.test(glyph.value) || glyph.value === '-') lastBreak = current.length;
    current.push(glyph);
  }
  if (current.length) flush();
  if (!output.length) output.push([]);
  return output.map(mergeRuns);
}

function scaledLines(lines: LbxTextRun[][], scale: number, object: LbxTextObject): TextLayoutLine[] {
  const charSpace = object.charSpace * scale;
  return lines.map((line) => {
    const runs = line.map((run) => ({
      ...run,
      fontSize: Math.max(0.01, run.fontSize || object.fontSize || 10) * Math.max(0.01, scale),
    }));
    return { runs, width: lineWidth(runs, charSpace), ...lineMetrics(runs, object, scale) };
  });
}

function contentSize(lines: TextLayoutLine[]): { width: number; height: number } {
  return {
    width: Math.max(0, ...lines.map((line) => line.width)),
    // b-PAC sizes LONGTEXT to complete font line boxes. This is observable
    // through the COM Bounds: 1/2/3 10 pt lines are 13.4/22.4/33.6 pt.
    // Explicit lineSpace extends baseline advances but adds no trailing gap.
    height: lines.length
      ? lines.slice(0, -1).reduce((sum, line) => sum + line.height, 0) + (lines.at(-1)?.inkHeight ?? 0)
      : 0,
  };
}

function modeOf(object: LbxTextObject): string {
  const control = object.control.trim().toUpperCase();
  return control === 'AUTOMATIC' ? 'AUTOLEN' : control || 'FREE';
}

export function layoutText(object: LbxTextObject): TextLayoutResult {
  const originalBounds = {
    ...object.bounds,
    width: Math.max(0, object.bounds.width),
    height: Math.max(0, object.bounds.height),
  };
  const mode = modeOf(object);
  const wrapping = mode === 'LONGTEXTFIXED' || mode === 'LONGTEXT' || (mode === 'FIXEDFRAME' && object.autoLineFeed);
  const explicit = splitExplicitLines(object);
  const wrapAtScale = (candidateScale: number) => wrapping
    ? explicit.flatMap((line) => wrapLine(line, originalBounds.width, object.charSpace, candidateScale))
    : explicit;
  let wrapped = wrapAtScale(1);
  let scale = 1;
  let lines = scaledLines(wrapped, scale, object);
  let size = contentSize(lines);
  const fixed = mode === 'FIXEDFRAME' || mode === 'LONGTEXTFIXED';
  const allowShrink = object.shrink;
  if (fixed && allowShrink && (size.width > originalBounds.width || size.height > originalBounds.height)) {
    if (wrapping) {
      // Wrapping and font size influence each other. Find the largest scale
      // whose reflowed text fits the original fixed frame.
      let low = 0.01;
      let high = 1;
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const candidate = (low + high) / 2;
        const candidateLines = scaledLines(wrapAtScale(candidate), candidate, object);
        const candidateSize = contentSize(candidateLines);
        if (candidateSize.width <= originalBounds.width + 1e-6 && candidateSize.height <= originalBounds.height + 1e-6) low = candidate;
        else high = candidate;
      }
      scale = low;
      wrapped = wrapAtScale(scale);
    } else {
      scale = Math.max(0.01, Math.min(
        1,
        size.width > 0 ? originalBounds.width / size.width : 1,
        size.height > 0 ? originalBounds.height / size.height : 1,
      ));
    }
    lines = scaledLines(wrapped, scale, object);
    size = contentSize(lines);
  }

  let bounds = { ...originalBounds };
  if (mode === 'LONGTEXT') {
    bounds.height = Math.max(originalBounds.height, size.height);
    // LONGTEXT grows around the original vertical centre. Native b-PAC moves
    // Y upward by exactly half the height increase.
    bounds.y = originalBounds.y - (bounds.height - originalBounds.height) / 2;
  }
  else if (mode === 'AUTOLEN') {
    // The legacy renderer deliberately left rotated/vertical AUTOLEN frames
    // untouched. Preserve that behavior until native b-PAC golden output is
    // available for their axis and anchor semantics.
    if (!object.vertical && !object.angle) bounds.width = Math.round(size.width * 10) / 10;
    bounds.height = originalBounds.height;
  } else if (mode === 'FREE') {
    bounds.width = size.width;
    bounds.height = size.height;
  }
  const overflow = size.width > originalBounds.width + 1e-6 || size.height > originalBounds.height + 1e-6;
  return {
    bounds,
    originalBounds,
    lines,
    scale,
    charSpace: object.charSpace * scale,
    contentWidth: size.width,
    contentHeight: size.height,
    overflow,
  };
}
