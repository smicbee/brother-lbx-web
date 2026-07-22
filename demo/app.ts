import { parseLBX, renderToSvg, setObject, walkObjects } from '../src/index.js';
import type { LbxDocument, LbxObject } from '../src/types.js';
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
    title: 'Produktetikett',
    description: 'Tabelle, Datum, Preis und CODE39',
    file: './examples/product-label.lbx',
    values: { product: 'Ethiopia Guji', price: '€ 12,90', weight: '250 g', barcode: 'GUJI0426', date: '2026-07-22' },
  },
  {
    title: 'QR-Testlabel',
    description: 'QR Model 2 mit frei änderbarem Ziel',
    file: './examples/qr-test-label.lbx',
    values: { title: 'LBX Print Bench', description: 'WebUSB Demo / QL-820NWB', qr: 'https://bpac.michaelbeetz.de/', payloadCaption: 'bpac.michaelbeetz.de' },
  },
  {
    title: 'Endlosband 12 mm',
    description: 'Auto-Länge und einfacher Text',
    file: './examples/text-strip-12mm.lbx',
    values: { Text1: 'LAB · SAMPLE 2026-042' },
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

function isBindable(object: LbxObject): object is LbxObject & { value: string } {
  return Boolean(object.name) && (object.kind === 'text' || object.kind === 'barcode' || object.kind === 'datetime');
}

function uniqueBindableObjects(documentValue: LbxDocument): Array<LbxObject & { value: string }> {
  const byName = new Map<string, LbxObject & { value: string }>();
  for (const object of walkObjects(documentValue)) if (isBindable(object) && !byName.has(object.name)) byName.set(object.name, object);
  return [...byName.values()];
}

function displayKind(object: LbxObject): string {
  if (object.kind === 'barcode') return `Barcode · ${object.protocol || 'unbekannt'}`;
  if (object.kind === 'datetime') return 'Datum';
  return 'Text';
}

function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

function setFacts(documentValue?: LbxDocument): void {
  byId('fact-file').textContent = currentFileName || 'Noch keine';
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

function renderParameterFields(documentValue: LbxDocument): void {
  parameterFields.replaceChildren();
  const objects = uniqueBindableObjects(documentValue);
  parameterEmpty.hidden = objects.length > 0;
  byId('field-count').textContent = `${objects.length} ${objects.length === 1 ? 'Feld' : 'Felder'}`;
  initialValues = new Map(objects.map((object) => [object.name, object.value]));

  for (const object of objects) {
    const label = document.createElement('label');
    label.className = 'field';
    const title = document.createElement('span');
    title.textContent = fieldLabel(object.name);
    const input = document.createElement('input');
    input.name = object.name;
    input.value = object.value;
    input.type = object.kind === 'datetime' && /^\d{4}-\d{2}-\d{2}$/.test(object.value) ? 'date' : 'text';
    input.autocomplete = 'off';
    input.dataset.objectKind = object.kind;
    const help = document.createElement('small');
    help.textContent = `${object.name} · ${displayKind(object)}`;
    input.addEventListener('input', () => {
      if (!currentDocument) return;
      setObject(currentDocument, object.name, input.value);
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
  const inferred = Number.parseInt(documentValue.paper.format ?? '', 10);
  mediaSelect.value = supportedMedia.some((medium) => medium.id === inferred) ? String(inferred) : '259';
}

function renderPreview(): void {
  if (!currentDocument) return;
  try {
    currentSvg = renderToSvg(currentDocument, { includeMetadata: false });
    const blob = new Blob([currentSvg], { type: 'image/svg+xml' });
    const nextUrl = URL.createObjectURL(blob);
    preview.onload = () => {
      if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = nextUrl;
    };
    preview.src = nextUrl;
    preview.hidden = false;
    previewEmpty.hidden = true;
    downloadButton.disabled = false;
    resetButton.disabled = false;
    updatePrintButton();
    const warningCount = currentDocument.warnings.length;
    setDiagnostics(
      warningCount ? `${warningCount} Hinweis${warningCount === 1 ? '' : 'e'}: ${currentDocument.warnings[0]?.message ?? 'unbekanntes Objekt'}` : 'LBX vollständig geparst · Vorschau lokal erzeugt',
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
  if (bytes.byteLength > maxUploadBytes) throw new Error('Die LBX-Datei ist größer als 10 MB.');
  const parsed = parseLBX(bytes);
  currentDocument = parsed;
  currentFileName = name;
  selectInferredMedia(parsed);
  renderParameterFields(parsed);
  if (values) applyValues(values);
  setFacts(parsed);
  renderPreview();
}

async function loadFile(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.lbx')) throw new Error('Bitte eine Datei mit der Endung .lbx auswählen.');
  await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function loadExample(example: DemoExample): Promise<void> {
  setDiagnostics(`${example.title} wird geladen …`);
  const response = await fetch(example.file, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Beispiel konnte nicht geladen werden (${response.status}).`);
  await loadBytes(new Uint8Array(await response.arrayBuffer()), example.file.split('/').at(-1) ?? 'example.lbx', example.values);
  showToast(`${example.title} geladen`, 'ok');
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
  if (!(width > 0) || !(height > 0)) throw new Error('Die SVG-Vorschau enthält keine gültige Größe.');
  return { width, height };
}

async function svgToRawImage(svg: string, targetWidth: number): Promise<RawImageData> {
  const dimensions = svgViewBox(svg);
  const targetHeight = Math.max(1, Math.round(targetWidth * dimensions.height / dimensions.width));
  if (targetWidth * targetHeight > 25_000_000) throw new Error('Das Druckbild überschreitet das 25-Megapixel-Limit.');
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
    if (!context) throw new Error('Canvas ist in diesem Browser nicht verfügbar.');
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
  if (!('usb' in navigator)) throw new Error('WebUSB fehlt. Bitte Chrome oder Edge verwenden.');
  connectButton.disabled = true;
  connectButton.textContent = 'USB-Gerät auswählen …';
  try {
    if (printer?.connected) await printer.close();
    printer = await connectBrotherQlWebUsb() as ConnectedPrinter;
    printerState.textContent = printer.model;
    printerState.classList.add('is-connected');
    connectButton.textContent = 'Anderen Drucker verbinden';
    showToast(`${printer.model} verbunden`, 'ok');
    updatePrintButton();
    printer.getStatus().then((status) => {
      const detail = status.media?.name ? `${printer?.model} · ${status.media.name}` : printer?.model ?? 'Verbunden';
      printerState.textContent = detail;
    }).catch(() => { /* Printing remains available when status polling is unsupported. */ });
  } finally {
    connectButton.disabled = false;
    if (!printer?.connected) connectButton.textContent = 'Brother QL verbinden';
  }
}

async function printCurrent(): Promise<void> {
  if (!currentDocument || !currentSvg) throw new Error('Zuerst eine LBX-Vorlage laden.');
  if (!printer?.connected) throw new Error('Zuerst einen Brother QL verbinden.');
  const media = findMedia(Number(mediaSelect.value));
  if (!media || media.tapeSystem !== 'dk' || !media.printableDots) throw new Error('Das gewählte Medium wird nicht unterstützt.');
  const copies = Number.parseInt(copiesInput.value, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new Error('Kopien müssen zwischen 1 und 99 liegen.');
  printButton.disabled = true;
  printButton.querySelector('span')!.textContent = 'Druckdaten werden erzeugt …';
  try {
    const raw = await svgToRawImage(currentSvg, media.printableDots);
    await printer.print(raw, media, { copies, autoCut: cutInput.checked, cutAtEnd: cutInput.checked, rotate: 'auto' });
    showToast(`${copies} Druckauftrag${copies === 1 ? '' : 'e'} an ${printer.model} gesendet`, 'ok');
  } finally {
    printButton.querySelector('span')!.textContent = 'Druckauftrag senden';
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
  if (file) loadFile(file).then(() => showToast(`${file.name} geladen`, 'ok')).catch(handleError);
  fileInput.value = '';
});
for (const eventName of ['dragenter', 'dragover']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
for (const eventName of ['dragleave', 'drop']) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0];
  if (file) loadFile(file).then(() => showToast(`${file.name} geladen`, 'ok')).catch(handleError);
});

connectButton.addEventListener('click', () => connectPrinter().catch(handleError));
printButton.addEventListener('click', () => printCurrent().catch(handleError));
resetButton.addEventListener('click', () => {
  if (!currentDocument) return;
  for (const [name, value] of initialValues) setObject(currentDocument, name, value);
  renderParameterFields(currentDocument);
  renderPreview();
  showToast('Feldwerte zurückgesetzt', 'ok');
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
  runtimeLabel.textContent = 'WebUSB verfügbar';
} else {
  runtimeStatus.classList.add('is-error');
  runtimeLabel.textContent = 'Vorschau · kein WebUSB';
}
loadExample(examples[0]!).catch(handleError);
