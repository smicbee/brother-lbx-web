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
  color: string;
  horizontalAlign: 'LEFT' | 'CENTER' | 'RIGHT';
  verticalAlign: 'TOP' | 'CENTER' | 'BOTTOM';
}

export interface LbxBarcodeObject extends LbxObjectBase {
  kind: 'barcode';
  value: string;
  protocol: string;
  humanReadable: boolean;
  barWidth: number;
  barRatio: string;
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

export type LbxObject = LbxTextObject | LbxBarcodeObject | LbxDateTimeObject | LbxImageObject | LbxTableObject | LbxUnknownObject;

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
