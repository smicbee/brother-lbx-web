export interface LbxPointRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LbxPaper {
  width: number;
  height: number;
  media?: string;
  printerName?: string;
  format?: string;
  orientation?: string;
  attributes: Record<string, string>;
}

export interface LbxWarning {
  tag: string;
  path: string;
  message: string;
}

export interface LbxResource {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface LbxObjectBase {
  kind: string;
  tag: string;
  path: string;
  name: string;
  bounds: LbxPointRect;
  angle: number;
  attributes: Record<string, string>;
  children: LbxObject[];
}

export interface LbxTextObject extends LbxObjectBase {
  kind: 'text';
  value: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  color: string;
  horizontalAlign: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  verticalAlign: 'TOP' | 'CENTER' | 'BOTTOM';
  control: string;
  clipFrame: boolean;
  shrink: boolean;
  autoLineFeed: boolean;
  charSpace: number;
  lineSpace: number;
  vertical: boolean;
  runs: LbxTextRun[];
}

export interface LbxTextRun {
  value: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  color: string;
}

export interface LbxBarcodeObject extends LbxObjectBase {
  kind: 'barcode';
  value: string;
  protocol: string;
  humanReadable: boolean;
  barWidth: number;
  barRatio: string;
  qrCode?: {
    model: number;
    errorCorrectionLevel: string;
    cellSize: number;
    margin: boolean;
    version?: number;
  };
}

export interface LbxDateTimeObject extends LbxObjectBase {
  kind: 'datetime';
  value: string;
  date: string;
  hour: number;
  minute: number;
  mode: string;
  format: string;
}

export interface LbxImageObject extends LbxObjectBase {
  kind: 'image';
  resourceName: string;
  resource?: LbxResource;
  originalName?: string;
}

export interface LbxPolyObject extends LbxObjectBase {
  kind: 'poly';
  shape: string;
  points: Array<{ x: number; y: number }>;
  stroke: string;
  strokeWidth: number;
}

export interface LbxTableCell {
  x: number;
  y: number;
  spanX: number;
  spanY: number;
  bounds?: LbxPointRect;
  objects: LbxObject[];
}

export interface LbxTableObject extends LbxObjectBase {
  kind: 'table';
  rows: number;
  columns: number;
  gridX: number[];
  gridY: number[];
  cells: LbxTableCell[];
}

export interface LbxUnknownObject extends LbxObjectBase {
  kind: 'unknown';
  rawXml: string;
}

export type LbxObject = LbxTextObject | LbxBarcodeObject | LbxDateTimeObject | LbxImageObject | LbxPolyObject | LbxTableObject | LbxUnknownObject;

export interface LbxDocument {
  paper: LbxPaper;
  objects: LbxObject[];
  resources: Record<string, LbxResource>;
  warnings: LbxWarning[];
  sourceFiles: string[];
  metadata: Record<string, string>;
}

export type LbxInput = Uint8Array | ArrayBuffer;
export type BindingValue = string | number | Date;

export interface SvgRenderOptions {
  fontFamily?: string;
  defaultFontSize?: number;
  includeMetadata?: boolean;
  imageResolver?: (resource: LbxResource) => string;
}

export interface QlRasterOptions {
  mediaId?: number;
  printer?: 'QL-820NWB' | 'QL-820NWBc';
  copies?: number;
  autoCut?: boolean;
  cutAtEnd?: boolean;
  marginDots?: number;
}
