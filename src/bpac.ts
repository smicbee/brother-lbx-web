import { MEDIA } from '@thermal-label/brother-ql-core';
import type { BrotherQLMedia } from '@thermal-label/brother-ql-core';
import { parseLBX, walkObjects } from './parser.js';
import { renderToSvg } from './svg.js';
import type { BindingValue, LbxDocument, LbxInput, LbxObject, LbxPointRect, SvgRenderOptions } from './types.js';

const POINTS_PER_MM = 72 / 25.4;
const SUPPORTED_PRINTERS = new Map([
  ['ql-820nwb', { canonicalName: 'Brother QL-820NWB', targetModel: 'dk' }],
  ['ql-820nwbc', { canonicalName: 'Brother QL-820NWBc', targetModel: 'dk' }],
]);

export interface BpacMedia {
  id: number;
  name: string;
  tapeSystem: BrotherQLMedia['tapeSystem'];
  type: BrotherQLMedia['type'];
  widthMm: number;
  heightMm?: number;
  skus: readonly string[];
}

export interface SetMediaOptions {
  fitPage?: boolean;
}

function normalizePrinterName(name: string): string {
  return name.trim().replace(/^Brother\s+/i, '').toLowerCase();
}

function printerProfile(name: string) {
  return SUPPORTED_PRINTERS.get(normalizePrinterName(name));
}

function mediaList(): BrotherQLMedia[] {
  return Object.values(MEDIA).sort((left, right) => left.id - right.id);
}

function publicMedia(media: BrotherQLMedia): BpacMedia {
  return {
    id: media.id,
    name: media.name,
    tapeSystem: media.tapeSystem,
    type: media.type,
    widthMm: media.widthMm,
    ...(media.heightMm === undefined ? {} : { heightMm: media.heightMm }),
    skus: Object.freeze([...(media.skus ?? [])]),
  };
}

function mediaSupportedByPrinter(media: BrotherQLMedia, printerName: string): boolean {
  const profile = printerProfile(printerName);
  return profile !== undefined
    && media.tapeSystem === 'dk'
    && Boolean(media.targetModels?.includes(profile.targetModel));
}

function points(valueMm: number): number {
  return valueMm * POINTS_PER_MM;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function dataText(object: LbxObject): string | undefined {
  if (object.kind === 'text' || object.kind === 'barcode' || object.kind === 'datetime') return object.value;
  return undefined;
}

function setDataText(object: LbxObject, value: BindingValue): boolean {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (object.kind === 'text') {
    const style = object.runs[0] ?? {
      fontFamily: object.fontFamily,
      fontSize: object.fontSize,
      fontWeight: object.fontWeight,
      italic: object.italic,
      underline: object.underline,
      strikeout: object.strikeout,
      color: object.color,
    };
    object.value = text;
    object.runs = [{ ...style, value: text }];
    return true;
  }
  if (object.kind === 'barcode') {
    object.value = text;
    return true;
  }
  if (object.kind === 'datetime') {
    object.value = text;
    object.date = text;
    return true;
  }
  return false;
}

function scaleRect(rect: LbxPointRect, scaleX: number, scaleY: number): void {
  rect.x *= scaleX;
  rect.y *= scaleY;
  rect.width *= scaleX;
  rect.height *= scaleY;
}

function scaleObject(object: LbxObject, scaleX: number, scaleY: number): void {
  scaleRect(object.bounds, scaleX, scaleY);
  if (object.kind === 'table') {
    object.gridX = object.gridX.map((value) => value * scaleX);
    object.gridY = object.gridY.map((value) => value * scaleY);
    for (const cell of object.cells) {
      if (cell.bounds) scaleRect(cell.bounds, scaleX, scaleY);
      for (const child of cell.objects) scaleObject(child, scaleX, scaleY);
    }
  }
  for (const child of object.children) scaleObject(child, scaleX, scaleY);
}

function numericPaperFormat(document: LbxDocument): number | undefined {
  const raw = document.paper.format ?? document.paper.attributes.format;
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

function inferMedia(document: LbxDocument): BrotherQLMedia | undefined {
  const widthMm = document.paper.width / POINTS_PER_MM;
  const autoLength = document.paper.attributes.autoLength?.toLowerCase() === 'true';
  const heightMm = document.paper.height / POINTS_PER_MM;
  const widthCandidates = mediaList().filter((media) => media.tapeSystem === 'dk'
    && Math.abs(media.widthMm - widthMm) <= 0.25);
  const exactDieCut = autoLength ? [] : widthCandidates.filter((media) => media.type === 'die-cut'
    && media.heightMm !== undefined && Math.abs(media.heightMm - heightMm) <= 0.25);
  // A continuous roll may use either automatic or explicitly fixed label
  // length. Prefer an exact die-cut size, then fall back to continuous media.
  const candidates = exactDieCut.length > 0
    ? exactDieCut
    : widthCandidates.filter((media) => media.type === 'continuous');
  const twoColor = document.paper.attributes.printColorDisplay?.toLowerCase() === 'true';
  const supported = candidates.filter((media) => mediaSupportedByPrinter(media, document.paper.printerName ?? 'Brother QL-820NWB'));
  return supported.find((media) => (media.palette !== undefined) === twoColor)
    ?? supported[0]
    ?? candidates[0];
}

/** A browser-safe, registry-backed replacement for b-PAC's IPrinter media API. */
export class BpacPrinter {
  readonly name: string;

  constructor(name = 'Brother QL-820NWB') {
    const profile = printerProfile(name);
    this.name = profile?.canonicalName ?? name.trim();
  }

  get supported(): boolean {
    return printerProfile(this.name) !== undefined;
  }

  get Name(): string { return this.name; }

  getSupportedMedia(): BpacMedia[] {
    return mediaList().filter((media) => mediaSupportedByPrinter(media, this.name)).map(publicMedia);
  }

  getSupportedMediaIds(): number[] {
    return this.getSupportedMedia().map((media) => media.id);
  }

  getSupportedMediaNames(): string[] {
    return this.getSupportedMedia().map((media) => media.name);
  }

  isMediaIdSupported(mediaId: number): boolean {
    const media = MEDIA[mediaId];
    return media !== undefined && mediaSupportedByPrinter(media, this.name);
  }

  getMedia(mediaId: number): BpacMedia | undefined {
    const media = MEDIA[mediaId];
    return media && mediaSupportedByPrinter(media, this.name) ? publicMedia(media) : undefined;
  }

  GetSupportedMediaIds(): number[] { return this.getSupportedMediaIds(); }
  GetSupportedMediaNames(): string[] { return this.getSupportedMediaNames(); }
  IsMediaIdSupported(mediaId: number): boolean { return this.isMediaIdSupported(mediaId); }
}

/** Mutable wrapper for a named LBX object, analogous to b-PAC's IObject. */
export class BpacObject {
  constructor(readonly raw: LbxObject) {}

  get name(): string { return this.raw.name; }
  get type(): LbxObject['kind'] { return this.raw.kind; }
  get text(): string | undefined { return dataText(this.raw); }
  set text(value: string) {
    if (!setDataText(this.raw, value)) throw new Error(`LBX object ${this.name || this.raw.path} does not contain text data`);
  }
  get x(): number { return this.raw.bounds.x; }
  set x(value: number) { this.raw.bounds.x = finite(value, 'x'); }
  get y(): number { return this.raw.bounds.y; }
  set y(value: number) { this.raw.bounds.y = finite(value, 'y'); }
  get width(): number { return this.raw.bounds.width; }
  set width(value: number) { this.raw.bounds.width = finite(value, 'width'); }
  get height(): number { return this.raw.bounds.height; }
  set height(value: number) { this.raw.bounds.height = finite(value, 'height'); }

  setData(value: BindingValue): boolean { return setDataText(this.raw, value); }
  getData(): string | undefined { return dataText(this.raw); }
  setPosition(x: number, y: number, width: number, height: number): void {
    this.raw.bounds = {
      x: finite(x, 'x'),
      y: finite(y, 'y'),
      width: finite(width, 'width'),
      height: finite(height, 'height'),
    };
  }

  get Name(): string { return this.name; }
  get Type(): LbxObject['kind'] { return this.type; }
  get Text(): string | undefined { return this.text; }
  set Text(value: string) { this.text = value; }
  get X(): number { return this.x; }
  set X(value: number) { this.x = value; }
  get Y(): number { return this.y; }
  set Y(value: number) { this.y = value; }
  get Width(): number { return this.width; }
  set Width(value: number) { this.width = value; }
  get Height(): number { return this.height; }
  set Height(value: number) { this.height = value; }
  GetData(): string | undefined { return this.getData(); }
  SetData(value: BindingValue): boolean { return this.setData(value); }
  SetPosition(x: number, y: number, width: number, height: number): void { this.setPosition(x, y, width, height); }
}

/**
 * A cross-platform subset of b-PAC's IDocument API.
 *
 * It deliberately does not pretend to provide COM, installed-printer discovery,
 * live printer status, or physical printing. Those capabilities belong to
 * transport/status adapters.
 */
export class BpacDocument {
  readonly document: LbxDocument;
  private printerValue: BpacPrinter;

  constructor(document: LbxDocument) {
    this.document = document;
    this.printerValue = new BpacPrinter(document.paper.printerName ?? 'Brother QL-820NWB');
  }

  static open(input: LbxInput): BpacDocument {
    return new BpacDocument(parseLBX(input));
  }

  get printer(): BpacPrinter { return this.printerValue; }

  setPrinter(name: string, fitPage = false): boolean {
    const next = new BpacPrinter(name);
    if (!next.supported) return false;
    this.printerValue = next;
    this.document.paper.printerName = next.name;
    this.document.paper.attributes.printerName = next.name;
    const mediaId = this.getMediaId();
    if (fitPage && mediaId !== undefined && !next.isMediaIdSupported(mediaId)) {
      const supportedIds = next.getSupportedMediaIds();
      const fallback = next.isMediaIdSupported(259) ? 259 : supportedIds[0];
      if (fallback !== undefined) this.setMediaById(fallback, { fitPage: true });
    }
    return true;
  }

  getObject(name: string): BpacObject | undefined {
    const object = walkObjects(this.document).find((candidate) => candidate.name === name);
    return object ? new BpacObject(object) : undefined;
  }

  getObjects(name?: string): BpacObject[] {
    return walkObjects(this.document)
      .filter((object) => name === undefined || object.name === name)
      .map((object) => new BpacObject(object));
  }

  getMediaId(): number | undefined {
    return numericPaperFormat(this.document) ?? inferMedia(this.document)?.id;
  }

  getMediaName(): string | undefined {
    const id = this.getMediaId();
    return id === undefined ? undefined : MEDIA[id]?.name;
  }

  setMediaById(mediaId: number, options: SetMediaOptions | boolean = {}): boolean {
    const fitPage = typeof options === 'boolean' ? options : options.fitPage ?? false;
    const media = MEDIA[mediaId];
    if (!media || !mediaSupportedByPrinter(media, this.printer.name)) return false;

    const paper = this.document.paper;
    const oldWidth = paper.width;
    const oldHeight = paper.height;
    const newWidth = points(media.widthMm);
    const newHeight = media.type === 'die-cut' && media.heightMm !== undefined ? points(media.heightMm) : oldHeight;
    const landscape = paper.orientation?.toLowerCase() === 'landscape';

    paper.width = newWidth;
    paper.height = newHeight;
    paper.format = String(media.id);
    paper.attributes.width = `${newWidth}pt`;
    paper.attributes.height = `${newHeight}pt`;
    paper.attributes.format = String(media.id);
    if (media.type === 'die-cut') paper.attributes.autoLength = 'false';

    if (fitPage && oldWidth > 0 && oldHeight > 0) {
      const scaleX = landscape ? newHeight / oldHeight : newWidth / oldWidth;
      const scaleY = landscape ? newWidth / oldWidth : newHeight / oldHeight;
      for (const object of this.document.objects) scaleObject(object, scaleX, scaleY);
    }
    return true;
  }

  setMediaByName(name: string, options: SetMediaOptions | boolean = {}): boolean {
    const wanted = name.trim().toLowerCase();
    const media = mediaList().find((candidate) => mediaSupportedByPrinter(candidate, this.printer.name)
      && (candidate.name.toLowerCase() === wanted || candidate.skus?.some((sku) => sku.toLowerCase() === wanted)));
    return media ? this.setMediaById(media.id, options) : false;
  }

  renderToSvg(options: SvgRenderOptions = {}): string {
    return renderToSvg(this.document, options);
  }

  GetObject(name: string): BpacObject | undefined { return this.getObject(name); }
  GetObjects(name?: string): BpacObject[] { return this.getObjects(name); }
  GetMediaId(): number | undefined { return this.getMediaId(); }
  GetMediaName(): string | undefined { return this.getMediaName(); }
  GetPrinter(): BpacPrinter { return this.printer; }
  SetPrinter(name: string, fitPage = false): boolean { return this.setPrinter(name, fitPage); }
  SetMediaById(mediaId: number, fitPage = false): boolean { return this.setMediaById(mediaId, fitPage); }
  SetMediaByName(name: string, fitPage = false): boolean { return this.setMediaByName(name, fitPage); }
}

export function openBpacDocument(input: LbxInput): BpacDocument {
  return BpacDocument.open(input);
}
