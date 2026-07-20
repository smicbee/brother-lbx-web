# brother-lbx-web

A TypeScript/ESM MVP for reading Brother P-touch Editor `.lbx` templates on Linux/Node.js and in browsers. LBX files are read as ZIP archives, and the library keeps parsing, field binding, SVG rendering, Node.js PNG rendering, and Brother raster generation separate.

> **License: private, non-commercial use only.** This project is source-available,
> but it is not open-source software. Any use by or for a company, employer,
> client, or other organization requires separate prior written permission.
> See [LICENSE](./LICENSE) for the controlling terms and [LLMS.md](./LLMS.md)
> for the corresponding notice to LLMs and automated agents.

## Quick start

```bash
npm install
npm run build
node dist/cli.js template.lbx \
  --svg out.svg --png out.png --raster out.bin --json out.json \
  --set product='Coffee & Tea' --set barcode=ABC123
```

`out.bin` is an offline Brother QL raster job for 62 mm continuous DK media (registry ID `259`) in a QL-820NWB context. Generating the file does not prove that a physical print succeeded. A separate USB or TCP transport is required to send it to hardware.

## API

```ts
import { readFile } from 'node:fs/promises';
import { parseLBX, setObject, walkObjects, renderToSvg } from 'brother-lbx-web';
import { renderSvgToPng, pngToQlRasterJob } from 'brother-lbx-web/node';

const document = parseLBX(new Uint8Array(await readFile('template.lbx')));
setObject(document, 'product', 'Coffee & Tea');
setObject(document, 'barcode', 'ABC123');
setObject(document, 'date', '2026-07-20');

const svg = renderToSvg(document);
const png = await renderSvgToPng(svg, { dpi: 300 });
const job = await pngToQlRasterJob(png, {
  printer: 'QL-820NWB',
  mediaId: 259,
});

console.log(walkObjects(document).map((object) => [object.kind, object.name]));
```

## Cross-platform b-PAC compatibility API

The package also provides a browser-safe subset of Brother b-PAC's `IDocument`,
`IObject`, and `IPrinter` APIs. It uses the LBX parser and bundled media registry
directly; it does not load COM, `bpac.dll`, P-touch Editor, or a Brother Windows
driver.

```ts
import { readFile } from 'node:fs/promises';
import { BpacDocument } from 'brother-lbx-web';

const bpac = BpacDocument.open(
  new Uint8Array(await readFile('template.lbx')),
);

bpac.GetObject('product')!.Text = 'Coffee & Tea';
bpac.GetObject('barcode')!.SetData('ABC123');

console.log(bpac.GetMediaId());                 // 259
console.log(bpac.GetMediaName());               // 62mm continuous (DK-22205)
console.log(bpac.GetPrinter().GetSupportedMediaIds());

// Change to DK-11201 and proportionally fit recursive object geometry.
if (!bpac.SetMediaByName('DK-11201', true)) {
  throw new Error('Media is unknown or incompatible with this printer');
}

const svg = bpac.renderToSvg();
```

Both idiomatic camel-case methods (`getObject`, `setMediaById`) and b-PAC-style
aliases (`GetObject`, `SetMediaById`) are available. `BpacPrinter` currently
models the QL-820NWB/QL-820NWBc capability profile and returns the 19 standard-
width DK entries from the bundled registry; wide DK and PT media are excluded.
If an LBX has no numeric `format`, the layer can infer known DK media from its
paper dimensions and one-/two-color flag.

This is **source/API compatibility, not binary COM compatibility**. Installed-
printer enumeration, online state, the physically loaded roll, status packets,
and sending a print job require an explicit USB/TCP/WebUSB adapter. The library
will not fabricate those live capabilities from its static registry.

## Parser

- Supports `style:paper`, recursive `image:image`, `barcode:barcode`, `draw:poly` lines, `table:table`, `table:cell`, nested `text:text` and `datetime:datetime`, and top-level `text:text` objects.
- Preserves `pt:expanded/@objectName` as `name`. `setObject` and `setObjects` replace named text, barcode, and date values.
- Preserves Brother rich-text run font size, weight, italics, underline, strikeout, color, fixed-frame controls, clipping, alignment, and line spacing.
- Stores embedded JPEG, PNG, and BMP resources as `Uint8Array` values with detected MIME types.
- Preserves unknown direct or nested objects as `unknown` nodes with `rawXml`, XML tag/path diagnostics, and any recognized descendants.
- Validates the ZIP central directory before extraction: no absolute or `..` paths, encryption, ZIP64, or multi-disk archives; entry count and compressed, per-entry, XML, and expanded sizes are bounded.
- Applies XML node-count and nesting-depth limits before constructing the DOM.

## SVG

The renderer uses LBX points (`1 pt = 1/72 inch`) in the SVG view box. It supports styled text runs, safe XML escaping, embedded images as data URLs, CODE39 including the declared wide-to-narrow ratio, Brother QR Code Model 2 layouts with Brother-compatible mask scoring, dates, table borders/cell contents, straight-line drawing objects, clipping, and object rotation. Brother's `\D\A` QR payload escape is converted to CRLF before encoding.

For landscape templates, tape width and label length are mapped to the correct SVG axes. When `autoLength=true`, the very large P-touch placeholder length is replaced with the actual recursive object extent plus the trailing margin. The MVP uses SVG font fallbacks; pixel-identical Brother/Windows font metrics are not guaranteed.

## Node.js PNG and Brother raster output

`brother-lbx-web/node` uses `@resvg/resvg-js` for PNG rendering and `sharp` for RGBA conversion. Embedded 24-bit and 32-bit BMP resources are normalized through `bmp-js`; unused zero-alpha padding is treated as opaque. SVG output, embedded raster images, decoded PNGs, and raw RGBA data are protected by pixel limits.

Raster generation uses `@thermal-label/brother-ql-core@0.6.1`. The current public API deliberately supports only `QL-820NWB`/`QL-820NWBc` with standard-width DK media. Unknown IDs, wide-DK-only media, TZe/HSe media, incompatible printer names, and invalid copy counts are rejected instead of silently falling back.

## Media IDs

### Scope and meaning

The tables below contain **all 39 media entries known to the media registry bundled with `@thermal-label/brother-ql-core@0.6.1`**: 22 DK entries, 7 TZe/TZ tape widths, 5 HSe 2:1 tube widths, and 5 HSe 3:1 tube widths.

This is not guaranteed to be a complete list of every Brother consumable ever sold, every regional SKU, or future media. Entries without a confirmed SKU are marked accordingly.

`mediaId` is the registry/template lookup key used by this library and often corresponds to the LBX `style:paper/@format` value. It is **not transmitted as a single media-ID byte** in the QL raster protocol. The encoder resolves it to media type, width, length, margins, and printable geometry; the QL print-information command transmits those resolved properties.

Compatibility labels in the tables mean:

- **QL-820 supported**: accepted by the current `pngToQlRasterJob` implementation.
- **Wide DK only**: requires a 102 mm/wide-head QL model and is rejected for QL-820NWB.
- **PT registry only**: known to the dependency for PT raster engines but not accepted by this project's current QL-820-only encoder.

### DK rolls and die-cut labels

| Registry ID | Brother material / known SKU | Kind and nominal size | Current project |
|---:|---|---|---|
| 251 | DK-22251, black/red on white | Continuous, 62 mm | QL-820 supported |
| 257 | DK-22214 | Continuous, 12 mm | QL-820 supported |
| 258 | DK-22210 | Continuous, 29 mm | QL-820 supported |
| 259 | DK-22205 | Continuous, 62 mm | QL-820 supported; default |
| 260 | DK-22243 | Continuous, 102 mm | Wide DK only |
| 261 | DK-N55224 | Continuous, 54 mm | QL-820 supported |
| 262 | DK-22246 | Continuous, 50 mm | QL-820 supported |
| 264 | DK-22225 | Continuous, 38 mm | QL-820 supported |
| 269 | DK-11204 | Die-cut, 17 × 54 mm | QL-820 supported |
| 270 | DK-11203 | Die-cut, 17 × 87 mm | QL-820 supported |
| 271 | DK-11201 | Die-cut, 29 × 90 mm | QL-820 supported |
| 272 | DK-11218 | Die-cut, 38 × 90 mm | QL-820 supported |
| 273 | DK-11207 | Die-cut round, 58 mm diameter | QL-820 supported |
| 274 | DK-11209 | Die-cut, 62 × 29 mm | QL-820 supported |
| 275 | DK-11202 | Die-cut, 62 × 100 mm | QL-820 supported |
| 362 | SKU not confirmed | Die-cut round, 12 mm diameter | QL-820 supported by registry geometry |
| 363 | DK-11221 | Die-cut round, 24 mm diameter | QL-820 supported |
| 365 | DK-11240 | Die-cut, 102 × 51 mm | Wide DK only |
| 366 | DK-11241 | Die-cut, 102 × 152 mm | Wide DK only |
| 367 | DK-11219 | Die-cut, 39 × 48 mm | QL-820 supported |
| 370 | SKU not confirmed | Die-cut, 23 × 23 mm | QL-820 supported by registry geometry |
| 374 | SKU not confirmed | Die-cut, 52 × 29 mm | QL-820 supported by registry geometry |

### TZe / TZ laminated tape

These IDs describe tape width, not a particular color/adhesive SKU such as TZe-231. The exact cassette variant must therefore be determined separately.

| Registry ID | Material | Nominal width | Current project |
|---:|---|---:|---|
| 401 | TZe / TZ laminated tape | 3.5 mm | PT registry only |
| 402 | TZe / TZ laminated tape | 6 mm | PT registry only |
| 403 | TZe / TZ laminated tape | 9 mm | PT registry only |
| 404 | TZe / TZ laminated tape | 12 mm | PT registry only; dependency's PT default |
| 405 | TZe / TZ laminated tape | 18 mm | PT registry only |
| 406 | TZe / TZ laminated tape | 24 mm | PT registry only |
| 407 | TZe / TZ laminated tape | 36 mm | PT wide-head registry only |

### HSe heat-shrink tube, 2:1

The registry identifies tube width and shrink ratio but does not assign a specific regional SKU.

| Registry ID | Material | Nominal width | Current project |
|---:|---|---:|---|
| 421 | HSe heat-shrink tube, 2:1 | 5.8 mm | PT registry only |
| 422 | HSe heat-shrink tube, 2:1 | 8.8 mm | PT registry only |
| 423 | HSe heat-shrink tube, 2:1 | 11.7 mm | PT registry only |
| 424 | HSe heat-shrink tube, 2:1 | 17.7 mm | PT registry only |
| 425 | HSe heat-shrink tube, 2:1 | 23.6 mm | PT registry only |

### HSe heat-shrink tube, 3:1

| Registry ID | Material | Nominal width | Current project |
|---:|---|---:|---|
| 441 | HSe heat-shrink tube, 3:1 | 5.2 mm | PT registry only |
| 442 | HSe heat-shrink tube, 3:1 | 9.0 mm | PT registry only |
| 443 | HSe heat-shrink tube, 3:1 | 11.2 mm | PT registry only |
| 444 | HSe heat-shrink tube, 3:1 | 21.0 mm | PT registry only |
| 445 | HSe heat-shrink tube, 3:1 | 31.0 mm | PT wide-head registry only |

## Browser and WebUSB

The parser and SVG renderer have no Node.js `fs` or USB dependency. `brother-lbx-web/browser` exports `connectBrotherQlWebUsb`, which lazily imports `@thermal-label/brother-ql-web` only when called:

```ts
import { connectBrotherQlWebUsb } from 'brother-lbx-web/browser';

const printer = await connectBrotherQlWebUsb(); // user gesture + HTTPS/localhost
```

WebUSB generally requires a Chromium-based browser, a secure context, and a user gesture. Firefox, Safari, and unsupported platforms require a local bridge or Node.js transport. Device permission, operating-system/driver support, and loaded media must be checked separately.

## MVP limitations

The MVP does not yet fully reproduce arbitrary free-drawing objects, every rich-text wrapping/shrink case, barcode protocols other than CODE39 and QR Code Model 2, Brother's exact Windows/GDI font rasterization, or physical USB/TCP transport. Unsupported XML objects are reported instead of being silently discarded.

## Tests and fixture provenance

```bash
npm test
npm run build
```

The real fixture at `test/fixtures/template.lbx` is an unchanged file from [`yeasir01/bpac-js`](https://github.com/yeasir01/bpac-js), pinned to commit `20b299012d49550d398085b312fd54748d6020a9`. It contains a QL-820NWB layout with an embedded JPEG, a CODE39 barcode, and a nested table. It is used only as test data; no GPL source code is incorporated.

End-to-end tests also use two public LBX files from [`jdlien/lbx-utils`](https://github.com/jdlien/lbx-utils), pinned to commit `2600c2c2361eb54dc0c4c404d0646494eb99147b`:

- `default-text-only-12mm.lbx` — landscape, auto-length, and text
- `single_image.lbx` — embedded 32-bit BMP

The tests cover parsing, SVG dimensions, visible PNG pixels, and Brother raster commands. Source URLs and SHA-256 checksums are documented in `test/fixtures/README.md`.
