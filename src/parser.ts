import { unzipSync } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type {
  BindingValue, LbxBarcodeObject, LbxDateTimeObject, LbxDocument, LbxImageObject,
  LbxObject, LbxPaper, LbxPointRect, LbxPolyObject, LbxResource, LbxTableCell,
  LbxTableObject, LbxTextObject, LbxTextRun, LbxUnknownObject, LbxWarning,
  LbxInput,
} from './types.js';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';

const OBJECT_TAGS = new Set(['text', 'barcode', 'datetime', 'image', 'poly', 'table']);
const IGNORED_CONTAINER_TAGS = new Set(['objectStyle', 'pen', 'brush', 'expanded', 'textFontInfo', 'ptFontInfo', 'logFont', 'fontExt', 'textControl', 'textAlign', 'textStyle', 'stringItem', 'barcodeStyle', 'transparent', 'trimming', 'orgPos', 'effect', 'mono', 'tableStyle', 'gridPosition', 'cells', 'cell', 'data', 'dateTimeStyle', 'dateAndTime']);

const ARCHIVE_LIMITS = {
  compressedBytes: 64 * 1024 * 1024,
  entries: 256,
  entryBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  xmlDepth: 256,
  xmlNodes: 100_000,
} as const;

function xmlTagEnd(xml: string, start: number): number {
  let quote = '';
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  throw new Error('LBX XML contains an unterminated tag');
}

/** Reject hostile/deep XML before constructing a DOM or entering recursive AST parsing. */
function validateXmlComplexity(xml: string): void {
  let cursor = 0;
  let depth = 0;
  let nodes = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) throw new Error('LBX XML contains an unterminated comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) throw new Error('LBX XML contains unterminated CDATA');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) throw new Error('LBX XML contains an unterminated processing instruction');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', start)) throw new Error('LBX XML declarations/DOCTYPE are not supported');
    const end = xmlTagEnd(xml, start + 1);
    if (xml.startsWith('</', start)) {
      depth -= 1;
      if (depth < 0) throw new Error('LBX XML has unbalanced closing tags');
    } else {
      nodes += 1;
      if (nodes > ARCHIVE_LIMITS.xmlNodes) throw new Error('LBX XML exceeds node-count limit');
      let tail = end - 1;
      while (tail > start && /\s/.test(xml[tail] ?? '')) tail -= 1;
      if (xml[tail] !== '/') {
        depth += 1;
        if (depth > ARCHIVE_LIMITS.xmlDepth) throw new Error('LBX XML exceeds nesting-depth limit');
      }
    }
    cursor = end + 1;
  }
  if (depth !== 0) throw new Error('LBX XML has unbalanced element depth');
}

function safeEntryName(name: string): boolean {
  return !name.startsWith('/') && !name.startsWith('\\') && !/^[A-Za-z]:/.test(name)
    && !name.split(/[\\/]+/).some((part) => part === '..');
}

/** Read and validate the ZIP central directory before any entry is inflated. */
function validateArchive(input: Uint8Array): void {
  if (input.byteLength > ARCHIVE_LIMITS.compressedBytes) throw new Error('LBX archive exceeds compressed size limit');
  if (input.byteLength < 22) throw new Error('LBX archive is too short to contain a ZIP directory');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const searchStart = Math.max(0, input.byteLength - 65_557);
  let eocd = -1;
  for (let offset = input.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === eocdSignature) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('LBX archive has no valid ZIP end record');

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('Multi-disk LBX ZIP archives are not supported');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 LBX archives are not supported');
  if (entryCount > ARCHIVE_LIMITS.entries) throw new Error('LBX archive contains too many entries');
  if (centralOffset + centralSize > eocd) throw new Error('LBX ZIP central directory is out of bounds');

  const decoder = new TextDecoder();
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > input.byteLength || view.getUint32(cursor, true) !== centralSignature) throw new Error('LBX ZIP central directory is malformed');
    const flags = view.getUint16(cursor + 8, true);
    const expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > input.byteLength) throw new Error('LBX ZIP entry metadata is out of bounds');
    if ((flags & 0x0001) !== 0) throw new Error('Encrypted LBX ZIP entries are not supported');
    if (expanded === 0xffffffff) throw new Error('ZIP64 LBX entries are not supported');
    if (expanded > ARCHIVE_LIMITS.entryBytes) throw new Error('LBX ZIP entry exceeds size limit');
    expandedBytes += expanded;
    if (expandedBytes > ARCHIVE_LIMITS.expandedBytes) throw new Error('LBX archive exceeds expanded size limit');
    const name = decoder.decode(input.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!safeEntryName(name)) throw new Error(`Unsafe LBX ZIP entry path: ${name}`);
    if ((name === 'label.xml' || name === 'prop.xml') && expanded > ARCHIVE_LIMITS.xmlBytes) throw new Error(`${name} exceeds XML size limit`);
    cursor = end;
  }
}

function localName(node: XmlNode): string {
  return (node.localName || node.nodeName || '').split(':').pop() || '';
}

function attrs(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = {};
  if (!element.attributes) return result;
  for (let i = 0; i < element.attributes.length; i += 1) {
    const item = element.attributes.item(i);
    if (item) result[item.name] = item.value;
  }
  return result;
}

function children(element: XmlElement | undefined): XmlElement[] {
  const result: XmlElement[] = [];
  if (!element) return result;
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) result.push(node as XmlElement);
  }
  return result;
}

function firstChild(element: XmlElement | undefined, wanted: string): XmlElement | undefined {
  return children(element).find((child) => localName(child) === wanted);
}

function textOf(element: XmlElement | undefined): string {
  return element?.textContent ?? '';
}

function numberAttr(element: XmlElement | undefined, name: string, fallback = 0): number {
  const value = element?.getAttribute(name);
  if (!value) return fallback;
  const parsed = Number.parseFloat(value.replace(/pt$/i, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanAttr(element: XmlElement | undefined, name: string, fallback = false): boolean {
  const value = element?.getAttribute(name);
  return value === null || value === undefined || value === '' ? fallback : value.toLowerCase() === 'true' || value === '1';
}

function rectFromStyle(style: XmlElement | undefined): LbxPointRect {
  return {
    x: numberAttr(style, 'x'),
    y: numberAttr(style, 'y'),
    width: numberAttr(style, 'width'),
    height: numberAttr(style, 'height'),
  };
}

function expandedName(style: XmlElement | undefined): string {
  return firstChild(style as XmlElement, 'expanded')?.getAttribute('objectName') ?? '';
}

function objectStyle(element: XmlElement): XmlElement | undefined {
  return firstChild(element, 'objectStyle');
}

function baseObject(element: XmlElement, path: string): Omit<LbxObject, 'kind'> {
  const style = objectStyle(element);
  return {
    tag: element.nodeName,
    path,
    name: expandedName(style),
    bounds: rectFromStyle(style),
    angle: numberAttr(style, 'angle'),
    attributes: attrs(element),
    children: [],
  } as Omit<LbxObject, 'kind'>;
}

function resourceMime(name: string, bytes: Uint8Array): string {
  const lower = name.toLowerCase();
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'application/octet-stream';
}

function parsePaper(root: XmlElement): LbxPaper {
  let paper: XmlElement | undefined;
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i += 1) {
    if (localName(all.item(i) as XmlElement) === 'paper') { paper = all.item(i) as XmlElement; break; }
  }
  const paperAttrs = attrs(paper as XmlElement);
  const sheet = paper?.parentNode?.parentNode as XmlElement | undefined;
  return {
    width: numberAttr(paper, 'width'),
    height: numberAttr(paper, 'height'),
    media: paper?.getAttribute('media') || undefined,
    printerName: paper?.getAttribute('printerName') || undefined,
    format: paper?.getAttribute('format') || undefined,
    orientation: paper?.getAttribute('orientation') || undefined,
    attributes: { ...paperAttrs, ...(sheet?.getAttribute('name') ? { sheetName: sheet.getAttribute('name') as string } : {}) },
  };
}

function parseTextRunStyle(fontInfo: XmlElement | undefined): Omit<LbxTextRun, 'value'> {
  const logFont = firstChild(fontInfo as XmlElement, 'logFont');
  const fontExt = firstChild(fontInfo as XmlElement, 'fontExt');
  return {
    fontFamily: logFont?.getAttribute('name') || undefined,
    fontSize: numberAttr(fontExt, 'size', numberAttr(fontExt, 'orgSize', 10)),
    fontWeight: Math.max(1, Math.round(numberAttr(logFont, 'weight', 400))),
    italic: booleanAttr(logFont, 'italic'),
    underline: numberAttr(fontExt, 'underline') !== 0,
    strikeout: numberAttr(fontExt, 'strikeout') !== 0,
    color: fontExt?.getAttribute('textColor') || '#000000',
  };
}

function parseTextRuns(element: XmlElement, value: string, fallback: Omit<LbxTextRun, 'value'>): LbxTextRun[] {
  const characters = Array.from(value);
  const runs: LbxTextRun[] = [];
  let offset = 0;
  const append = (run: LbxTextRun) => {
    const previous = runs.at(-1);
    if (previous
      && previous.fontFamily === run.fontFamily
      && previous.fontSize === run.fontSize
      && previous.fontWeight === run.fontWeight
      && previous.italic === run.italic
      && previous.underline === run.underline
      && previous.strikeout === run.strikeout
      && previous.color === run.color) {
      previous.value += run.value;
    } else runs.push(run);
  };
  for (const item of children(element).filter((child) => localName(child) === 'stringItem')) {
    const length = Math.max(0, Number.parseInt(item.getAttribute('charLen') || '0', 10) || 0);
    if (!length) continue;
    const runValue = characters.slice(offset, offset + length).join('');
    if (runValue) append({ value: runValue, ...parseTextRunStyle(firstChild(item, 'ptFontInfo')) });
    offset += length;
  }
  if (offset < characters.length) append({ value: characters.slice(offset).join(''), ...fallback });
  return runs.length ? runs : [{ value, ...fallback }];
}

function parseText(element: XmlElement, path: string): LbxTextObject {
  const style = objectStyle(element);
  const font = parseTextRunStyle(firstChild(element, 'ptFontInfo'));
  const align = firstChild(element, 'textAlign');
  const control = firstChild(element, 'textControl');
  const textStyle = firstChild(element, 'textStyle');
  const value = textOf(firstChild(element, 'data'));
  return {
    ...baseObject(element, path),
    kind: 'text',
    value,
    ...font,
    horizontalAlign: (align?.getAttribute('horizontalAlignment') || 'LEFT') as LbxTextObject['horizontalAlign'],
    verticalAlign: (align?.getAttribute('verticalAlignment') || 'TOP') as LbxTextObject['verticalAlign'],
    control: control?.getAttribute('control') || 'FREE',
    clipFrame: booleanAttr(control, 'clipFrame'),
    shrink: booleanAttr(control, 'shrink'),
    autoLineFeed: booleanAttr(control, 'autoLF'),
    charSpace: numberAttr(textStyle, 'charSpace'),
    lineSpace: numberAttr(textStyle, 'lineSpace'),
    vertical: booleanAttr(textStyle, 'vertical'),
    runs: parseTextRuns(element, value, font),
    bounds: rectFromStyle(style),
  };
}

function parseBarcode(element: XmlElement, path: string): LbxBarcodeObject {
  const style = firstChild(element, 'barcodeStyle');
  const qrStyle = firstChild(element, 'qrcodeStyle');
  const versionValue = qrStyle?.getAttribute('version') || '';
  const parsedVersion = Number.parseInt(versionValue, 10);
  return {
    ...baseObject(element, path),
    kind: 'barcode',
    value: textOf(firstChild(element, 'data')),
    protocol: style?.getAttribute('protocol') || 'CODE39',
    humanReadable: (style?.getAttribute('humanReadable') || 'false') === 'true',
    barWidth: numberAttr(style, 'barWidth', 1),
    barRatio: style?.getAttribute('barRatio') || '1:3',
    qrCode: (style?.getAttribute('protocol') || '').toUpperCase() === 'QRCODE' ? {
      model: Number.parseInt(qrStyle?.getAttribute('model') || '2', 10) || 2,
      errorCorrectionLevel: qrStyle?.getAttribute('eccLevel') || '15%',
      cellSize: numberAttr(qrStyle, 'cellSize', 1),
      margin: booleanAttr(style, 'margin', true),
      version: Number.isInteger(parsedVersion) && parsedVersion >= 1 && parsedVersion <= 40 ? parsedVersion : undefined,
    } : undefined,
  };
}

function parseDateTime(element: XmlElement, path: string): LbxDateTimeObject {
  const style = firstChild(element, 'dateTimeStyle');
  const dateAndTime = firstChild(element, 'dateAndTime');
  const date = dateAndTime?.getAttribute('date') || '';
  const hour = Number.parseInt(dateAndTime?.getAttribute('hour') || '0', 10) || 0;
  const minute = Number.parseInt(dateAndTime?.getAttribute('minute') || '0', 10) || 0;
  return {
    ...baseObject(element, path),
    kind: 'datetime',
    value: date,
    date,
    hour,
    minute,
    mode: style?.getAttribute('mode') || 'DATE',
    format: style?.getAttribute('format') || '',
  };
}

function findResource(resources: Record<string, LbxResource>, name: string): LbxResource | undefined {
  return resources[name] ?? Object.values(resources).find((resource) => resource.name.toLowerCase() === name.toLowerCase());
}

function parseImage(element: XmlElement, path: string, resources: Record<string, LbxResource>): LbxImageObject {
  const style = firstChild(element, 'imageStyle');
  const resourceName = style?.getAttribute('fileName') || style?.getAttribute('originalName') || '';
  return {
    ...baseObject(element, path),
    kind: 'image',
    resourceName,
    resource: findResource(resources, resourceName),
    originalName: style?.getAttribute('originalName') || undefined,
  };
}

function parsePoints(raw: string | null | undefined): Array<{ x: number; y: number }> {
  return (raw || '').trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',');
    return {
      x: Number.parseFloat((x || '0').replace(/pt$/i, '')) || 0,
      y: Number.parseFloat((y || '0').replace(/pt$/i, '')) || 0,
    };
  }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function parsePoly(element: XmlElement, path: string): LbxPolyObject {
  const style = objectStyle(element);
  const pen = firstChild(style as XmlElement, 'pen');
  const polyStyle = firstChild(element, 'polyStyle');
  const points = firstChild(polyStyle as XmlElement, 'polyLinePoints');
  return {
    ...baseObject(element, path),
    kind: 'poly',
    shape: polyStyle?.getAttribute('shape') || 'LINE',
    points: parsePoints(points?.getAttribute('points')),
    stroke: pen?.getAttribute('color') || '#000000',
    strokeWidth: Math.max(numberAttr(pen, 'widthX', 0.5), numberAttr(pen, 'widthY', 0.5)),
  };
}

function parseGrid(raw: string | null | undefined): number[] {
  return (raw || '').split(/\s+/).filter(Boolean).map((value) => {
    const parsed = Number.parseFloat(value.replace(/pt$/i, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function parseTable(element: XmlElement, path: string, resources: Record<string, LbxResource>, warnings: LbxWarning[]): LbxTableObject {
  const style = firstChild(element, 'tableStyle');
  const grid = firstChild(element, 'gridPosition');
  const cellsParent = firstChild(element, 'cells');
  const cells: LbxTableCell[] = [];
  for (const cell of cellsParent ? children(cellsParent) : []) {
    if (localName(cell) !== 'cell') continue;
    const cellPath = `${path}/table:cell[${cells.length}]`;
    const objects = parseContainerObjects(cell, cellPath, resources, warnings);
    cells.push({
      x: Number.parseInt(cell.getAttribute('addressX') || '1', 10) || 1,
      y: Number.parseInt(cell.getAttribute('addressY') || '1', 10) || 1,
      spanX: Number.parseInt(cell.getAttribute('spanX') || '1', 10) || 1,
      spanY: Number.parseInt(cell.getAttribute('spanY') || '1', 10) || 1,
      objects,
    });
  }
  return {
    ...baseObject(element, path),
    kind: 'table',
    rows: Number.parseInt(style?.getAttribute('row') || '0', 10) || 0,
    columns: Number.parseInt(style?.getAttribute('column') || '0', 10) || 0,
    gridX: parseGrid(grid?.getAttribute('x')),
    gridY: parseGrid(grid?.getAttribute('y')),
    cells,
  };
}

function knownObject(element: XmlElement): boolean {
  return OBJECT_TAGS.has(localName(element));
}

function unknownObject(element: XmlElement, path: string, resources: Record<string, LbxResource>, warnings: LbxWarning[]): LbxUnknownObject {
  const warning = { tag: element.nodeName, path, message: `Unsupported LBX object preserved at ${path}` };
  warnings.push(warning);
  const nested = parseContainerObjects(element, `${path}/*`, resources, warnings);
  return { ...baseObject(element, path), kind: 'unknown', rawXml: new XMLSerializer().serializeToString(element), children: nested };
}

function parseObject(element: XmlElement, path: string, resources: Record<string, LbxResource>, warnings: LbxWarning[]): LbxObject {
  switch (localName(element)) {
    case 'text': return parseText(element, path);
    case 'barcode': return parseBarcode(element, path);
    case 'datetime': return parseDateTime(element, path);
    case 'image': return parseImage(element, path, resources);
    case 'poly': return parsePoly(element, path);
    case 'table': return parseTable(element, path, resources, warnings);
    default: return unknownObject(element, path, resources, warnings);
  }
}

function parseContainerObjects(container: XmlElement, path: string, resources: Record<string, LbxResource>, warnings: LbxWarning[]): LbxObject[] {
  const result: LbxObject[] = [];
  let index = 0;
  for (const child of children(container)) {
    const tag = localName(child);
    if (knownObject(child) || !IGNORED_CONTAINER_TAGS.has(tag)) {
      result.push(parseObject(child, `${path}/${child.nodeName}[${index}]`, resources, warnings));
      index += 1;
    }
  }
  return result;
}

function zipBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function parseLBX(input: Uint8Array | ArrayBuffer): LbxDocument {
  const archiveBytes = zipBytes(input);
  validateArchive(archiveBytes);
  const entries = unzipSync(archiveBytes);
  const names = Object.keys(entries);
  let actualExpandedBytes = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (!safeEntryName(name)) throw new Error(`Unsafe LBX ZIP entry path: ${name}`);
    if (bytes.byteLength > ARCHIVE_LIMITS.entryBytes) throw new Error('LBX ZIP entry exceeds size limit');
    actualExpandedBytes += bytes.byteLength;
  }
  if (actualExpandedBytes > ARCHIVE_LIMITS.expandedBytes) throw new Error('LBX archive exceeds expanded size limit');
  const labelBytes = entries['label.xml'];
  if (!labelBytes) throw new Error('LBX archive does not contain label.xml');
  const resources: Record<string, LbxResource> = {};
  for (const name of names) {
    if (name === 'label.xml' || name === 'prop.xml' || name.endsWith('/')) continue;
    resources[name] = { name, bytes: new Uint8Array(labelBytes === entries[name] ? entries[name].slice() : entries[name]), mime: resourceMime(name, entries[name]) };
  }
  const xml = new TextDecoder().decode(labelBytes);
  validateXmlComplexity(xml);
  const parseErrors: string[] = [];
  const parsed = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') parseErrors.push(String(message));
    },
  }).parseFromString(xml, 'text/xml');
  if (parseErrors.length) throw new Error(`Invalid LBX label.xml: ${parseErrors[0]}`);
  const root = parsed.documentElement as XmlElement;
  if (!root) throw new Error('LBX label.xml has no document element');
  const warnings: LbxWarning[] = [];
  const objectsRoot = Array.from(root.getElementsByTagName('*')).find((element) => localName(element as XmlElement) === 'objects') as XmlElement | undefined;
  if (!objectsRoot) throw new Error('LBX label.xml has no objects container');
  const paper = parsePaper(root);
  if (!(paper.width > 0) || !(paper.height > 0)) throw new Error('LBX label.xml has invalid paper dimensions');
  const objects = parseContainerObjects(objectsRoot, '/pt:objects', resources, warnings);
  const metadata: Record<string, string> = {};
  for (const attr of ['version', 'generator']) {
    const value = root.getAttribute(attr);
    if (value) metadata[attr] = value;
  }
  return { paper, objects, resources, warnings, sourceFiles: names, metadata };
}

export async function parseLBXAsync(input: LbxInput | Blob): Promise<LbxDocument> {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return parseLBX(new Uint8Array(await input.arrayBuffer()));
  return parseLBX(input as Uint8Array | ArrayBuffer);
}

export function walkObjects(document: LbxDocument): LbxObject[] {
  const result: LbxObject[] = [];
  const visit = (object: LbxObject) => {
    result.push(object);
    if (object.kind === 'table') for (const cell of object.cells) for (const child of cell.objects) visit(child);
    for (const child of object.children) visit(child);
  };
  for (const object of document.objects) visit(object);
  return result;
}

function bindingText(value: BindingValue): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function setObject(document: LbxDocument, name: string, value: BindingValue): boolean {
  let changed = false;
  const rendered = bindingText(value);
  for (const object of walkObjects(document)) {
    if (object.name !== name) continue;
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
      object.value = rendered;
      object.runs = [{ ...style, value: rendered }];
      changed = true;
    } else if (object.kind === 'barcode') { object.value = rendered; changed = true; }
    else if (object.kind === 'datetime') { object.value = rendered; object.date = rendered; changed = true; }
  }
  return changed;
}

export function setObjects(document: LbxDocument, bindings: Record<string, BindingValue>): string[] {
  return Object.entries(bindings).filter(([name, value]) => setObject(document, name, value)).map(([name]) => name);
}
