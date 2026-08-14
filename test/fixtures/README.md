# Test fixtures

## `template.lbx`

Source: [`yeasir01/bpac-js`](https://github.com/yeasir01/bpac-js), pinned to commit:

`20b299012d49550d398085b312fd54748d6020a9`

URL:

`https://raw.githubusercontent.com/yeasir01/bpac-js/20b299012d49550d398085b312fd54748d6020a9/test/browser/assets/template.lbx`

SHA-256:

`1fe24132c402235e0112ab3c7ede5c1a9a056c242dcee8317b8390e800c5da2c`

This test asset contains a QL-820NWB layout with an embedded JPEG, a CODE39 barcode, and a nested table. It is used solely as a real parser/renderer fixture; the project does not incorporate GPL source code.

## Public internet fixtures

Source: [`jdlien/lbx-utils`](https://github.com/jdlien/lbx-utils), MIT-licensed and pinned to commit:

`2600c2c2361eb54dc0c4c404d0646494eb99147b`

### `internet/default-text-only-12mm.lbx`

URL:

`https://raw.githubusercontent.com/jdlien/lbx-utils/2600c2c2361eb54dc0c4c404d0646494eb99147b/data/label_templates/default-text-only-12mm.lbx`

SHA-256:

`6661f1fb07b62a3d7d0b2c049f89179bfd6b6d3fc6b9d729076b554e3b72c78a`

Covers landscape orientation, `autoLength=true`, and text rendering.

### `internet/single_image.lbx`

URL:

`https://raw.githubusercontent.com/jdlien/lbx-utils/2600c2c2361eb54dc0c4c404d0646494eb99147b/data/label_templates/single_image.lbx`

SHA-256:

`2b2b10593379eef763dca8146820b8f050f64b2c68e218136b06953ba9481cd7`

Covers an embedded 32-bit BMP resource.

## User-supplied SEO/FA regression corpus

Directory: `seo-fa-lab-rev1/`

Source: `1_SEO_FA_LAB_rev1.zip`, supplied by the project owner for LBX compatibility regression testing on 2026-08-14. The corpus contains all 75 supplied files: 38 current `.lbx` templates and 37 `.lbx.bak` revisions. Before inclusion, internal UNC printer queue names were normalized to `Brother PT-P950NW`; label content, geometry, and embedded resources were otherwise preserved. `manifest.json` records every original filename plus the committed byte size and SHA-256 digest so accidental fixture changes are detected.

The parameterized corpus test opens every file as an LBX archive, parses every object, requires zero parser warnings, renders deterministic SVG, rasterizes to PNG, and verifies visible output. It also binds every `date_inlabqueue_date` field.

Despite the date-like field names, this archive contains **no native Brother `text:datetime` object**. Its 20 `date_inlabqueue_date` occurrences are ordinary bindable text objects. Native `atPrint` and DateTime format-ID behavior is covered separately by the synthetic DateTime regression in `test/lbx.test.ts`.
