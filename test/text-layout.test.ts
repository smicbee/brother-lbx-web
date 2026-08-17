import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BpacDocument } from '../src/bpac.js';
import { renderSvgToPng, pngToRawImageData } from '../src/node.js';
import { estimatedGlyphWidth } from '../src/text-layout.js';
import type { LbxTextObject } from '../src/types.js';

type TextControl = {
  control: string;
  autoLF?: boolean;
  clipFrame?: boolean;
  shrink?: boolean;
  frame?: boolean;
};

function textLbx(control: TextControl, value = 'A very long Brother label value', paper = '100pt" height="50pt"', rich = false): Uint8Array {
  const split = Math.max(1, Math.floor([...value].length / 2));
  const richRuns = rich ? `<text:stringItem charLen="${split}"><text:ptFontInfo><text:logFont name="Arial" weight="400"/><text:fontExt size="10pt" textColor="#000000"/></text:ptFontInfo></text:stringItem><text:stringItem charLen="${[...value].length - split}"><text:ptFontInfo><text:logFont name="Arial" weight="700"/><text:fontExt size="10pt" textColor="#000000"/></text:ptFontInfo></text:stringItem>` : '';
  const label = `<?xml version="1.0"?>
    <pt:document xmlns:pt="urn:pt" xmlns:text="urn:text" xmlns:style="urn:style">
      <pt:body><style:sheet><style:paper width="${paper}/><pt:objects>
        <text:text><pt:objectStyle x="5pt" y="5pt" width="40pt" height="20pt">${control.frame ? '<pt:pen style="INSIDEFRAME" widthX="0.5pt" widthY="0.5pt" color="#000000"/><pt:brush style="NULL" color="#000000"/>' : ''}<pt:expanded objectName="label"/></pt:objectStyle>
          <text:ptFontInfo><text:logFont name="Arial" weight="400"/><text:fontExt size="10pt" textColor="#000000"/></text:ptFontInfo>
          <text:textControl control="${control.control}" autoLF="${String(control.autoLF ?? false)}" clipFrame="${String(control.clipFrame ?? false)}" shrink="${String(control.shrink ?? true)}"/>
          <text:textAlign horizontalAlignment="LEFT" verticalAlignment="TOP"/>
          <text:textStyle charSpace="0" lineSpace="0"/>
          <pt:data>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pt:data>${richRuns}
        </text:text>
      </pt:objects></style:sheet></pt:body>
    </pt:document>`;
  return zipSync({ 'label.xml': new TextEncoder().encode(label) });
}

function openText(control: TextControl, value?: string, paper?: string, rich = false): BpacDocument {
  return BpacDocument.open(textLbx(control, value, paper, rich));
}

function lineStarts(svg: string): number {
  return (svg.match(/<tspan x=/g) ?? []).length;
}

function darkBounds(raw: { width: number; height: number; data: Uint8Array }): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = raw.width;
  let minY = raw.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      const offset = (y * raw.width + x) * 4;
      if ((raw.data[offset] ?? 255) < 220 || (raw.data[offset + 1] ?? 255) < 220 || (raw.data[offset + 2] ?? 255) < 220) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

describe('Brother text layout modes through BpacDocument', () => {
  it('shrinks a FIXEDFRAME value while preserving the fixed frame in the PNG', async () => {
    const document = openText({ control: 'FIXEDFRAME', clipFrame: true, shrink: true });
    const object = document.GetObject('label');
    expect(object).toBeDefined();
    if (!object) return;
    object.Text = 'A very long Brother label value';

    const svg = document.renderToSvg();
    expect(svg).toContain('clip-path=');
    expect(svg).toMatch(/font-size="(?:[0-9.]*)"/);
    expect(Number(svg.match(/font-size="([0-9.]+)"/)?.[1])).toBeLessThan(10);
    expect(lineStarts(svg)).toBe(1);

    const raw = await (async () => pngToRawImageData(await renderSvgToPng(svg, { fitWidth: 400 })))();
    const bounds = darkBounds(raw);
    // 100pt -> 400px; the text ink must remain inside x=5..45pt/y=5..25pt.
    expect(bounds.minX).toBeGreaterThanOrEqual(17);
    expect(bounds.maxX).toBeLessThanOrEqual(183);
    expect(bounds.minY).toBeGreaterThanOrEqual(17);
    expect(bounds.maxY).toBeLessThanOrEqual(103);
  });

  it('keeps the real Task-TaskDetail bold FIXEDFRAME ink inside its 178pt frame', async () => {
    const document = openText(
      { control: 'FIXEDFRAME', clipFrame: false, shrink: true },
      'Application/Bench Measurement',
      '102.4pt" height="292pt" orientation="landscape"',
    );
    const object = document.GetObject('label');
    if (!object || object.raw.kind !== 'text') throw new Error('label text object missing');
    object.raw.bounds = { x: 103.6, y: 32.8, width: 178, height: 16 };
    object.raw.fontSize = 14;
    object.raw.fontWeight = 700;
    object.raw.verticalAlign = 'CENTER';
    object.raw.runs = object.raw.runs.map((run) => ({
      ...run,
      fontFamily: 'Arial',
      fontSize: 14,
      fontWeight: 700,
    }));

    const svg = document.renderToSvg();
    const scale = Number(svg.match(/data-lbx-layout-scale="([0-9.]+)"/)?.[1]);
    expect(scale).toBeGreaterThan(0.81);
    expect(scale).toBeLessThan(0.83);

    const raw = await pngToRawImageData(await renderSvgToPng(svg, { dpi: 360 }));
    const bounds = darkBounds(raw);
    // At 360 DPI one point is five pixels. Native b-PAC keeps this bound title
    // inside x=103.6..281.6pt; the previous regular-font estimate leaked 40px.
    expect(raw.width).toBe(1460);
    expect(bounds.minX).toBeGreaterThanOrEqual(518);
    expect(bounds.maxX).toBeLessThanOrEqual(1408);
  });

  it('wraps LONGTEXTFIXED into several lines and shrinks parsed rich-text runs together', () => {
    const document = openText({ control: 'LONGTEXTFIXED', clipFrame: true, shrink: true }, 'A very long Brother label value', undefined, true);
    const svg = document.renderToSvg();

    expect(lineStarts(svg)).toBeGreaterThan(1);
    expect(svg).toContain('clip-path=');
    expect(svg).toContain('font-weight="400"');
    expect(svg).toContain('font-weight="700"');
    const sizes = [...svg.matchAll(/font-size="([0-9.]+)"/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThan(10);
  });


  it('wraps LONGTEXT, grows its effective height, and keeps clipFrame as a final step', () => {
    const document = openText({ control: 'LONGTEXT', clipFrame: false });
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    object.Text = 'A very long Brother label value';
    const svg = document.renderToSvg();

    expect(lineStarts(svg)).toBeGreaterThan(1);
    expect(svg).not.toContain('clip-path=');
    expect(Number(svg.match(/data-lbx-effective-width="([0-9.]+)/)?.[1])).toBe(40);
    expect(Number(svg.match(/data-lbx-effective-height="([0-9.]+)/)?.[1])).toBeGreaterThan(20);
    // A growing LONGTEXT frame must not enlarge a fixed physical label.
    expect(svg).toContain('viewBox="0 0 100 50"');
  });

  it('matches native b-PAC LONGTEXT line boxes and centre-preserving growth', () => {
    const document = openText({ control: 'LONGTEXT', clipFrame: false }, 'A\nA');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    if (object.raw.kind !== 'text') throw new Error('label is not text');
    object.raw.bounds = { x: 70.9, y: 25.5, width: 114.7, height: 13.4 };
    object.raw.verticalAlign = 'CENTER';
    object.Text = 'A\nA';

    const svg = document.renderToSvg();
    expect(svg).toContain('data-lbx-effective-height="22.4"');
    expect(svg).toContain(' y="30.1"');
    expect(svg).toContain(' dy="11.2"');
  });

  it('renders INSIDEFRAME pen geometry around text objects', () => {
    const document = openText({ control: 'FIXEDFRAME', frame: true }, 'IBP');
    const svg = document.renderToSvg();

    expect(svg).toContain('<rect x="5.25" y="5.25" width="39.5" height="19.5" fill="none" stroke="#000000" stroke-width="0.5"');
  });

  it('grows a LONGTEXT frame with the effective Brother object bounds', () => {
    const document = openText({ control: 'LONGTEXT', frame: true }, 'A\nA');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    const raw = object.raw as LbxTextObject;
    raw.bounds = { x: 5, y: 25.5, width: 114.7, height: 13.4 };
    raw.verticalAlign = 'CENTER';
    const svg = document.renderToSvg();

    expect(svg).toContain('<rect x="5.25" y="21.25" width="114.2" height="21.9"');
  });

  it('uses the public defaultFontSize option during layout', () => {
    const document = openText({ control: 'FREE' }, 'A');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    const raw = object.raw as LbxTextObject;
    raw.fontSize = 0;
    raw.runs = raw.runs.map((run) => ({ ...run, fontSize: 0 }));

    expect(document.renderToSvg({ defaultFontSize: 20 })).toContain('font-size="20"');
  });

  it('uses Calibri-compatible advances instead of generic glyph classes', () => {
    expect(estimatedGlyphWidth('W', 10, 'Calibri')).toBeCloseTo(8.9, 6);
    expect(estimatedGlyphWidth('W', 10, 'Calibri')).not.toBeCloseTo(estimatedGlyphWidth('W', 10, 'DejaVu Sans'), 2);
  });

  it('keeps accented and non-Latin Arial Bold glyphs inside narrow FIXEDFRAME objects', async () => {
    expect(estimatedGlyphWidth('Ä', 14, 'Arial', 700)).toBeCloseTo(estimatedGlyphWidth('A', 14, 'Arial', 700), 6);

    for (const value of ['Ä', 'Ω', '№']) {
      const document = openText({ control: 'FIXEDFRAME', clipFrame: false, shrink: true }, value);
      const object = document.GetObject('label');
      if (!object || object.raw.kind !== 'text') throw new Error('label text object missing');
      object.raw.bounds = { x: 5, y: 5, width: 9, height: 20 };
      object.raw.fontSize = 14;
      object.raw.fontWeight = 700;
      object.raw.runs = object.raw.runs.map((run) => ({
        ...run, value, fontFamily: 'Arial', fontSize: 14, fontWeight: 700,
      }));

      const raw = await pngToRawImageData(await renderSvgToPng(document.renderToSvg(), { fitWidth: 400 }));
      const bounds = darkBounds(raw);
      expect(bounds.minX).toBeGreaterThanOrEqual(20);
      expect(bounds.maxX).toBeLessThanOrEqual(56);
    }
  });

  it('uses AUTOLEN and AUTOMATIC as horizontal no-wrap modes', () => {
    for (const control of ['AUTOLEN', 'AUTOMATIC']) {
      const document = openText({ control });
      const object = document.GetObject('label');
      if (!object) throw new Error('label object missing');
      object.Text = 'A very long Brother label value';
      const svg = document.renderToSvg();
      expect(lineStarts(svg)).toBe(1);
      expect(Number(svg.match(/data-lbx-effective-width="([0-9.]+)/)?.[1])).toBeGreaterThan(40);
    }
  });

  it('keeps the AUTOLEN frame height fixed for explicit multiline text', () => {
    const document = openText({ control: 'AUTOLEN' }, 'first\nsecond\nthird');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    const svg = document.renderToSvg();

    expect(lineStarts(svg)).toBe(3);
    expect(Number(svg.match(/data-lbx-effective-height="([0-9.]+)/)?.[1])).toBe(20);
  });

  it('lets FREE adapt both dimensions without splitting grapheme clusters or rich runs', () => {
    const document = openText({ control: 'FREE' }, 'Café 👩‍🔬');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    const svg = document.renderToSvg();

    expect(Number(svg.match(/data-lbx-effective-width="([0-9.]+)/)?.[1])).toBeLessThan(40);
    expect(Number(svg.match(/data-lbx-effective-height="([0-9.]+)/)?.[1])).toBeLessThan(20);
    expect(svg).toContain('>Café ');
    expect(svg).not.toContain('\u200d');
  });

  it('preserves explicit CR/LF breaks even when automatic wrapping is disabled', () => {
    const document = openText({ control: 'AUTOMATIC' }, 'first\r\nsecond\nthird');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    object.Text = 'first\r\nsecond\nthird';
    const svg = document.renderToSvg();

    expect(lineStarts(svg)).toBe(3);
    expect(svg).toContain('>first<');
    expect(svg).toContain('>second<');
    expect(svg).toContain('>third<');
  });

  it('does not emit blank continuation lines when wrapping at whitespace', () => {
    const document = openText({ control: 'LONGTEXT', clipFrame: false }, 'abc def ghi');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    object.Text = 'abc def ghi';
    const svg = document.renderToSvg();

    expect(svg).not.toContain('></tspan>');
    expect(svg).not.toContain('> </tspan>');
  });

  it('matches b-PAC by treating a hyphen as a visible wrap boundary', () => {
    const document = openText({ control: 'LONGTEXT', clipFrame: false }, 'RB18SA-00051-OVERFLOW');
    const object = document.GetObject('label');
    if (!object || object.raw.kind !== 'text') throw new Error('label text object missing');
    object.Text = 'RB18SA-00051-OVERFLOW';
    object.raw.bounds.width = 128.8;
    object.raw.fontSize = 14;
    object.raw.fontWeight = 700;
    object.raw.runs = object.raw.runs.map((run) => ({ ...run, fontSize: 14, fontWeight: 700 }));
    const svg = document.renderToSvg();

    expect(svg).toContain('data-lbx-line-count="2"');
    expect(svg).toContain('>RB18SA-00051-</tspan>');
    expect(svg).toContain('>OVERFLOW</tspan>');
    expect(svg).not.toContain('>RB18SA-00051-OV</tspan>');
  });

  it('does not emit an empty first line for wrapped leading whitespace', () => {
    const document = openText({ control: 'LONGTEXT' }, ' abc');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    object.raw.bounds.width = 10;
    const svg = document.renderToSvg();

    expect(svg).not.toContain('<tspan x="5" dy="0"></tspan>');
  });

  it('applies lineSpace only between baselines, not after the final line', () => {
    const document = openText({ control: 'LONGTEXT' }, 'first\nsecond');
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    if (object.raw.kind !== 'text') throw new Error('label is not text');
    object.raw.lineSpace = 100;
    const svg = document.renderToSvg();

    expect(Number(svg.match(/data-lbx-effective-height="([0-9.]+)/)?.[1])).toBe(32.4);
  });

  it('fits quarter-turn FIXEDFRAME text against the saved long axis', () => {
    const document = openText({ control: 'FIXEDFRAME', frame: true, shrink: true }, 'SI19A1-00001');
    const object = document.GetObject('label');
    if (!object || object.raw.kind !== 'text') throw new Error('label text object missing');
    object.raw.bounds = { x: 8.9, y: 49.2, width: 28.7, height: 120 };
    object.raw.angle = 270;
    object.raw.fontSize = 18;
    object.raw.fontWeight = 700;
    object.raw.verticalAlign = 'CENTER';
    object.raw.runs = object.raw.runs.map((run) => ({
      ...run, value: 'SI19A1-00001', fontFamily: 'Arial', fontSize: 18, fontWeight: 700,
    }));

    const svg = document.renderToSvg();
    expect(svg).toContain('data-lbx-effective-width="120"');
    expect(svg).toContain('data-lbx-effective-height="28.7"');
    expect(svg).toContain('data-lbx-layout-scale="1"');
    expect(svg).toContain('<rect x="-36.5" y="95.1" width="119.5" height="28.2"');
    expect(svg).toContain('rotate(270 23.25 109.2)');
    expect(svg).toContain('font-size="18"');
  });

  it('keeps 90 and 270 degree FIXEDFRAME ink inside the saved page AABB at 360 DPI', async () => {
    for (const angle of [90, 270]) {
      const document = openText(
        { control: 'FIXEDFRAME', shrink: true },
        'SI19A1-00001',
        '180pt" height="200pt"',
      );
      const object = document.GetObject('label');
      if (!object || object.raw.kind !== 'text') throw new Error('label text object missing');
      object.raw.bounds = { x: 20, y: 40, width: 28.7, height: 120 };
      object.raw.angle = angle;
      object.raw.fontSize = 18;
      object.raw.fontWeight = 700;
      object.raw.verticalAlign = 'CENTER';
      object.raw.runs = object.raw.runs.map((run) => ({
        ...run, value: 'SI19A1-00001', fontFamily: 'Arial', fontSize: 18, fontWeight: 700,
      }));

      const raw = await pngToRawImageData(await renderSvgToPng(document.renderToSvg(), { dpi: 360 }));
      const bounds = darkBounds(raw);
      expect(raw.width).toBe(900);
      expect(raw.height).toBe(1000);
      expect(bounds.minX).toBeGreaterThanOrEqual(95);
      expect(bounds.maxX).toBeLessThanOrEqual(250);
      expect(bounds.minY).toBeGreaterThanOrEqual(195);
      expect(bounds.maxY).toBeLessThanOrEqual(805);
      expect(bounds.maxY - bounds.minY).toBeGreaterThan(450);
    }
  });

  it('preserves rotated AUTOLEN frame geometry until native axis semantics are calibrated', () => {
    const document = openText({ control: 'AUTOLEN' });
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    object.raw.angle = 90;
    object.Text = 'A very long Brother label value';
    const svg = document.renderToSvg();

    expect(Number(svg.match(/data-lbx-effective-width="([0-9.]+)/)?.[1])).toBe(40);
  });

  it('normalizes malformed negative geometry and spacing to valid SVG values', () => {
    const document = openText({ control: 'FIXEDFRAME', shrink: true });
    const object = document.GetObject('label');
    if (!object) throw new Error('label object missing');
    if (object.raw.kind !== 'text') throw new Error('label is not text');
    object.raw.bounds.width = -1;
    object.raw.lineSpace = -200;
    object.raw.runs[0]!.fontSize = -10;
    const svg = document.renderToSvg();

    expect(svg).toContain('data-lbx-effective-width="0"');
    expect(svg).not.toMatch(/font-size="-/);
    expect(svg).not.toMatch(/data-lbx-layout-scale="-/);
  });
});
