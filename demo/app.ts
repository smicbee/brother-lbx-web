import { getEditableFields, parseLBX, renderToSvg, setObject, walkObjects } from '../src/index.js';
import type { LbxDocument, LbxEditableField, LbxResource } from '../src/types.js';
import { connectBrotherQlWebUsb } from '../src/browser.js';
import { MEDIA, findMedia } from '@thermal-label/brother-ql-core';
import type { RawImageData } from '@thermal-label/brother-ql-core';

interface DemoExample {
  title: string;
  description: string;
  file: string;
  values?: Record<string, string>;
}

interface ConnectedPrinter {
  model: string;
  connected: boolean;
  print(image: RawImageData, media?: ReturnType<typeof findMedia>, options?: Record<string, unknown>): Promise<void>;
  getStatus(): Promise<{ state?: string; media?: { name?: string } }>;
  close(): Promise<void>;
}

const examples: DemoExample[] = [
  {
    title: 'Product label',
    description: 'Table, date, price, and CODE39',
    file: './examples/product-label.lbx',
    values: { product: 'Ethiopia Guji', price: '€12.90', weight: '250 g', barcode: 'GUJI0426', date: '2026-07-22' },
  },
  {
    title: 'QR test label',
    description: 'QR Model 2 with an editable destination',
    file: './examples/qr-test-label.lbx',
    values: { title: 'LBX Print Bench', description: 'WebUSB Demo / QL-820NWB', qr: 'https://bpac.michaelbeetz.de/', payloadCaption: 'bpac.michaelbeetz.de' },
  },
  {
    title: '12 mm continuous tape',
    description: 'Auto length and simple text',
    file: './examples/text-strip-12mm.lbx',
    values: { Text1: 'LAB · SAMPLE 2026-042' },
  },
  {
    title: 'Embedded image',
    description: 'LBX with an embedded 32-bit BMP resource',
    file: './examples/embedded-image.lbx',
  },
];

const supportedMedia = Object.values(MEDIA).filter((medium) => medium.tapeSystem === 'dk' && medium.targetModels?.includes('dk'));
const maxUploadBytes = 10 * 1024 * 1024;
let currentDocument: LbxDocument | undefined;
let currentFileName = '';
let currentSvg = '';
let currentPreviewUrl: string | undefined;
let initialValues = new Map<string, string>();
let printer: ConnectedPrinter | undefined;
let toastTimer: number | undefined;
let renderTimer: number | undefined;
let browserImageUrls = new Map<string, string>();

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const fileInput = byId<HTMLInputElement>('file-input');
const dropZone = byId<HTMLLabelElement>('drop-zone');
const preview = byId<HTMLImageElement>('label-preview');
const previewEmpty = byId<HTMLDivElement>('preview-empty');
const parameterFields = byId<HTMLDivElement>('parameter-fields');
const parameterEmpty = byId<HTMLDivElement>('parameter-empty');
const mediaSelect = byId<HTMLSelectElement>('media-select');
const copiesInput = byId<HTMLInputElement>('copies-input');
const cutInput = byId<HTMLInputElement>('cut-input');
const connectButton = byId<HTMLButtonElement>('connect-button');
const printButton = byId<HTMLButtonElement>('print-button');
const systemPrintButton = byId<HTMLButtonElement>('system-print-button');
const downloadButton = byId<HTMLButtonElement>('download-svg');
const resetButton = byId<HTMLButtonElement>('reset-values');
const diagnostics = byId<HTMLDivElement>('diagnostics');
const printerState = byId<HTMLSpanElement>('printer-state');
const runtimeStatus = byId<HTMLDivElement>('runtime-status');
const runtimeLabel = byId<HTMLSpanElement>('runtime-label');
const toast = byId<HTMLDivElement>('toast');

function showToast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  if (toastTimer) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${kind === 'info' ? '' : ` is-${kind}`}`;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4800);
}

function setDiagnostics(message: string, kind: 'ok' | 'warn' | 'error' = 'ok'): void {
  diagnostics.replaceChildren();
  const item = document.createElement('span');
  item.className = kind === 'ok' ? 'diagnostic-ok' : kind === 'warn' ? 'diagnostic-warn' : 'diagnostic-error';
  item.textContent = message;
  diagnostics.append(item);
}

function displayKind(field: LbxEditableField): string {
  if (field.kind === 'barcode') return 'Barcode';
  if (field.kind === 'datetime') return 'Date';
  return 'Text';
}

function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bmpToPngDataUrl(bytes: Uint8Array): string {
  if (bytes.byteLength < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('Embedded BMP has an invalid header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (dibSize < 40 || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height) || width * height > 25_000_000) {
    throw new Error('Embedded BMP exceeds the 25-megapixel limit.');
  }
  if ((bitsPerPixel !== 24 && bitsPerPixel !== 32) || compression !== 0) {
    throw new Error(`Embedded ${bitsPerPixel}-bit BMP compression is not supported in the browser preview.`);
  }
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.ceil(width * bytesPerPixel / 4) * 4;
  if (pixelOffset < 14 + dibSize || pixelOffset + rowStride * height > bytes.byteLength) throw new Error('Embedded BMP pixel data is truncated.');

  let preserveAlpha = false;
  if (bitsPerPixel === 32) {
    for (let row = 0; row < height && !preserveAlpha; row += 1) {
      for (let x = 0; x < width; x += 1) {
        if (bytes[pixelOffset + row * rowStride + x * 4 + 3] !== 0) {
          preserveAlpha = true;
          break;
        }
      }
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y;
    for (let x = 0; x < width; x += 1) {
      const source = pixelOffset + sourceY * rowStride + x * bytesPerPixel;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2] ?? 0;
      rgba[target + 1] = bytes[source + 1] ?? 0;
      rgba[target + 2] = bytes[source] ?? 0;
      rgba[target + 3] = preserveAlpha ? (bytes[source + 3] ?? 255) : 255;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available in this browser.');
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

function browserImageHref(resource: LbxResource): string {
  const cached = browserImageUrls.get(resource.name);
  if (cached) return cached;
  const url = resource.mime === 'image/bmp'
    ? bmpToPngDataUrl(resource.bytes)
    : `data:${resource.mime};base64,${bytesToBase64(resource.bytes)}`;
  browserImageUrls.set(resource.name, url);
  return url;
}

function setFacts(documentValue?: LbxDocument): void {
  byId('fact-file').textContent = currentFileName || 'None yet';
  if (!documentValue) {
    byId('fact-size').textContent = '–';
    byId('fact-objects').textContent = '–';
    return;
  }
  const widthMm = documentValue.paper.width / 72 * 25.4;
  const heightMm = documentValue.paper.height / 72 * 25.4;
  byId('fact-size').textContent = `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm`;
  byId('fact-objects').textContent = String(walkObjects(documentValue).length);
}

function setRenderedSize(svg: string): void {
  const { width, height } = svgViewBox(svg);
  const widthMm = width / 72 * 25.4;
  const heightMm = height / 72 * 25.4;
  byId('fact-size').textContent = `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm`;
}

function renderParameterFields(documentValue: LbxDocument): void {
  parameterFields.replaceChildren();
  const fields = getEditableFields(documentValue);
  parameterEmpty.hidden = fields.length > 0;
  byId('field-count').textContent = `${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`;
  initialValues = new Map(fields.map((field) => [field.name, field.value]));

  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'field';
    const title = document.createElement('span');
    title.textContent = fieldLabel(field.name);
    const input = field.multiline ? document.createElement('textarea') : document.createElement('input');
    input.name = field.name;
    input.value = field.value;
    if (input instanceof HTMLInputElement) {
      input.type = field.kind === 'datetime' && /^\d{4}-\d{2}-\d{2}$/.test(field.value) ? 'date' : 'text';
    } else {
      input.rows = 3;
    }
    input.autocomplete = 'off';
    input.dataset.objectKind = field.kind;
    const help = document.createElement('small');
    help.textContent = `${field.name} · ${displayKind(field)}${field.multiline ? ' · free text' : ''}`;
    input.addEventListener('input', () => {
      if (!currentDocument) return;
      setObject(currentDocument, field.name, input.value);
      scheduleRender();
    });
    label.append(title, input, help);
    parameterFields.append(label);
  }
}

function applyValues(values: Record<string, string>): void {
  if (!currentDocument) return;
  for (const [name, value] of Object.entries(values)) setObject(currentDocument, name, value);
  renderParameterFields(currentDocument);
}

function selectInferredMedia(documentValue: LbxDocument): void {
  const storedId = Number.parseInt(documentValue.paper.format ?? '', 10);
  const tapeWidthMm = documentValue.paper.width / 72 * 25.4;
  const storedMedium = supportedMedia.find((medium) => medium.id === storedId);
  if (storedMedium && Math.abs(storedMedium.widthMm - tapeWidthMm) <= 0.5) {
    mediaSelect.value = String(storedMedium.id);
    return;
  }
  const widthMatch = supportedMedia.find((medium) => medium.type === 'continuous' && Math.abs(medium.widthMm - tapeWidthMm) <= 0.5);
  mediaSelect.value = String(widthMatch?.id ?? 259);
}

function renderPreview(): void {
  if (!currentDocument) return;
  try {
    currentSvg = renderToSvg(currentDocument, { includeMetadata: false, imageResolver: browserImageHref });
    setRenderedSize(currentSvg);
    const blob = new Blob([currentSvg], { type: 'image/svg+xml' });
    const nextUrl = URL.createObjectURL(blob);
    preview.onload = () => {
      if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = nextUrl;
    };
    preview.src = nextUrl;
    preview.hidden = false;
    previewEmpty.hidden = true;
    const printSize = svgViewBox(currentSvg);
    preview.style.setProperty('--print-width', `${(printSize.width / 72 * 25.4).toFixed(3)}mm`);
    preview.style.setProperty('--print-height', `${(printSize.height / 72 * 25.4).toFixed(3)}mm`);
    systemPrintButton.disabled = false;
    downloadButton.disabled = false;
    resetButton.disabled = false;
    updatePrintButton();
    const warningCount = currentDocument.warnings.length;
    setDiagnostics(
      warningCount ? `${warningCount} warning${warningCount === 1 ? '' : 's'}: ${currentDocument.warnings[0]?.message ?? 'unknown object'}` : 'LBX parsed successfully · Preview rendered locally',
      warningCount ? 'warn' : 'ok',
    );
  } catch (error) {
    currentSvg = '';
    updatePrintButton();
    setDiagnostics(error instanceof Error ? error.message : String(error), 'error');
  }
}

function scheduleRender(): void {
  if (renderTimer) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderPreview, 90);
}

function updatePrintButton(): void {
  printButton.disabled = !currentDocument || !currentSvg || !printer?.connected;
}

async function loadBytes(bytes: Uint8Array, name: string, values?: Record<string, string>): Promise<void> {
  if (bytes.byteLength > maxUploadBytes) throw new Error('The LBX file is larger than 10 MB.');
  const parsed = parseLBX(bytes);
  currentDocument = parsed;
  browserImageUrls = new Map();
  currentSvg = '';
  currentFileName = name;
  selectInferredMedia(parsed);
  renderParameterFields(parsed);
  if (values) applyValues(values);
  setFacts(parsed);
  renderPreview();
}

async function loadFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.lbx')) throw new Error('Please choose a file with the .lbx extension.');
  await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function loadExample(example: DemoExample): Promise<void> {
  setDiagnostics(`Loading ${example.title} …`);
  const response = await fetch(example.file, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`The example could not be loaded (${response.status}).`);
  await loadBytes(new Uint8Array(await response.arrayBuffer()), example.file.split('/').at(-1) ?? 'example.lbx', example.values);
  showToast(`${example.title} loaded`, 'ok');
}

function renderExamples(): void {
  const list = byId<HTMLDivElement>('example-list');
  examples.forEach((example, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-button';
    const number = document.createElement('span');
    number.className = 'example-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'example-copy';
    const title = document.createElement('strong');
    title.textContent = example.title;
    const description = document.createElement('span');
    description.textContent = example.description;
    copy.append(title, description);
    button.append(number, copy);
    button.addEventListener('click', () => loadExample(example).catch(handleError));
    list.append(button);
  });
}

function populateMedia(): void {
  for (const medium of supportedMedia) {
    const option = document.createElement('option');
    option.value = String(medium.id);
    option.textContent = `${medium.name} · ID ${medium.id}`;
    if (medium.id === 259) option.selected = true;
    mediaSelect.append(option);
  }
}

function svgViewBox(svg: string): { width: number; height: number } {
  const match = svg.match(/\bviewBox=["']\s*[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*["']/i);
  const width = Number.parseFloat(match?.[1] ?? '');
  const height = Number.parseFloat(match?.[2] ?? '');
  if (!(width > 0) || !(height > 0)) throw new Error('The SVG preview does not contain valid dimensions.');
  return { width, height };
}

function cssMillimetres(value: number): string {
  return `${(Math.round(value * 1000) / 1000).toFixed(3)}mm`;
}

function setSystemPrintLayout(): void {
  if (!currentSvg) throw new Error('Load an LBX template first.');
  const medium = findMedia(Number(mediaSelect.value));
  if (!medium || medium.tapeSystem !== 'dk') throw new Error('The selected print media is not supported.');

  const dimensions = svgViewBox(currentSvg);
  const sourceWidthMm = dimensions.width / 72 * 25.4;
  const sourceHeightMm = dimensions.height / 72 * 25.4;
  let pageWidthMm: number;
  let pageHeightMm: number;
  let imageWidthMm: number;
  let imageHeightMm: number;
  let offsetX = 0;
  let offsetY = 0;

  if (medium.type === 'die-cut' && medium.heightMm) {
    pageWidthMm = medium.heightMm;
    pageHeightMm = medium.widthMm;
    const scale = Math.min(pageWidthMm / sourceWidthMm, pageHeightMm / sourceHeightMm);
    imageWidthMm = sourceWidthMm * scale;
    imageHeightMm = sourceHeightMm * scale;
    offsetX = (pageWidthMm - imageWidthMm) / 2;
    offsetY = (pageHeightMm - imageHeightMm) / 2;
  } else {
    pageHeightMm = medium.widthMm;
    const scale = pageHeightMm / sourceHeightMm;
    imageWidthMm = sourceWidthMm * scale;
    imageHeightMm = pageHeightMm;
    pageWidthMm = imageWidthMm;
  }

  if (![pageWidthMm, pageHeightMm, imageWidthMm, imageHeightMm].every((value) => Number.isFinite(value) && value > 0 && value <= 2000)) {
    throw new Error('The fitted print dimensions are outside the supported range.');
  }

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--print-page-width', cssMillimetres(pageWidthMm));
  rootStyle.setProperty('--print-page-height', cssMillimetres(pageHeightMm));
  preview.style.setProperty('--print-width', cssMillimetres(imageWidthMm));
  preview.style.setProperty('--print-height', cssMillimetres(imageHeightMm));
  preview.style.setProperty('--print-offset-x', cssMillimetres(offsetX));
  preview.style.setProperty('--print-offset-y', cssMillimetres(offsetY));

}

async function svgToRawImage(svg: string, targetWidth: number): Promise<RawImageData> {
  const dimensions = svgViewBox(svg);
  const targetHeight = Math.max(1, Math.round(targetWidth * dimensions.height / dimensions.width));
  if (targetWidth * targetHeight > 25_000_000) throw new Error('The print image exceeds the 25-megapixel limit.');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas is not available in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: pixels.width, height: pixels.height, data: new Uint8Array(pixels.data) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function connectPrinter(): Promise<void> {
  if (!('usb' in navigator)) throw new Error('WebUSB is unavailable. Please use Chrome or Edge.');
  connectButton.disabled = true;
  connectButton.textContent = 'Choose a USB device …';
  try {
    if (printer?.connected) await printer.close();
    printer = await connectBrotherQlWebUsb() as ConnectedPrinter;
    printerState.textContent = printer.model;
    printerState.classList.add('is-connected');
    connectButton.textContent = 'Connect another printer';
    showToast(`${printer.model} connected`, 'ok');
    updatePrintButton();
    printer.getStatus().then((status) => {
      const detail = status.media?.name ? `${printer?.model} · ${status.media.name}` : printer?.model ?? 'Connected';
      printerState.textContent = detail;
    }).catch(() => { /* Printing remains available when status polling is unsupported. */ });
  } finally {
    connectButton.disabled = false;
    if (!printer?.connected) connectButton.textContent = 'Connect Brother QL';
  }
}

async function printCurrent(): Promise<void> {
  if (!currentDocument || !currentSvg) throw new Error('Load an LBX template first.');
  if (!printer?.connected) throw new Error('Connect a Brother QL first.');
  const media = findMedia(Number(mediaSelect.value));
  if (!media || media.tapeSystem !== 'dk' || !media.printableDots) throw new Error('The selected media is not supported.');
  const copies = Number.parseInt(copiesInput.value, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new Error('Copies must be between 1 and 99.');
  printButton.disabled = true;
  printButton.querySelector('span')!.textContent = 'Preparing print data …';
  try {
    const raw = await svgToRawImage(currentSvg, media.printableDots);
    await printer.print(raw, media, { copies, autoCut: cutInput.checked, cutAtEnd: cutInput.checked, rotate: 'auto' });
    showToast(`${copies} print job${copies === 1 ? '' : 's'} sent to ${printer.model}`, 'ok');
  } finally {
    printButton.querySelector('span')!.textContent = 'Send print job';
    updatePrintButton();
  }
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setDiagnostics(message, 'error');
  showToast(message, 'error');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file).then(() => showToast(`${file.name} loaded`, 'ok')).catch(handleError);
  fileInput.value = '';
});
for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
for (const eventName of ['dragleave', 'drop']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0];
  if (file) loadFile(file).then(() => showToast(`${file.name} loaded`, 'ok')).catch(handleError);
});

connectButton.addEventListener('click', () => connectPrinter().catch(handleError));
printButton.addEventListener('click', () => printCurrent().catch(handleError));
systemPrintButton.addEventListener('click', () => {
  if (!currentSvg) return;
  try {
    setSystemPrintLayout();
    // Force style calculation before Chromium snapshots the document for print.
    void document.body.offsetHeight;
    window.print();
  } catch (error) {
    handleError(error);
  }
});
resetButton.addEventListener('click', () => {
  if (!currentDocument) return;
  for (const [name, value] of initialValues) setObject(currentDocument, name, value);
  renderParameterFields(currentDocument);
  renderPreview();
  showToast('Field values reset', 'ok');
});
downloadButton.addEventListener('click', () => {
  if (!currentSvg) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([currentSvg], { type: 'image/svg+xml' }));
  link.download = currentFileName.replace(/\.lbx$/i, '') + '.svg';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
window.addEventListener('beforeunload', () => { if (printer?.connected) void printer.close(); });

renderExamples();
populateMedia();
setFacts();
if ('usb' in navigator) {
  runtimeStatus.classList.add('is-ok');
  runtimeLabel.textContent = 'WebUSB available';
} else {
  runtimeStatus.classList.add('is-error');
  runtimeLabel.textContent = 'Preview · no WebUSB';
}
loadExample(examples[0]!).catch(handleError);
