# brother-lbx-web

TypeScript/ESM-MVP zum Lesen von Brother-P-touch-Editor-`.lbx`-Vorlagen unter Linux/Node und im Browser. LBX wird als ZIP gelesen; die Bibliothek trennt Parser, Bindings, SVG, Node-PNG und QL-Rasterprotokoll.

## Schnellstart

```bash
npm install
npm run build
node dist/cli.js template.lbx \
  --svg out.svg --png out.png --raster out.bin --json out.json \
  --set product='Coffee & Tea' --set barcode=ABC123
```

`out.bin` ist ein offline erzeugter Brother-QL-Rasterjob für 62-mm-DK-Endlosmaterial (Media-ID 259) und den QL-820NWB-Kontext. Das Programm behauptet keinen Hardwaredruck; zum Senden wird ein separater USB/TCP-Transport benötigt.

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
const job = await pngToQlRasterJob(png, { printer: 'QL-820NWB', mediaId: 259 });
console.log(walkObjects(document).map((object) => [object.kind, object.name]));
```

### Parser

- Unterstützt `style:paper`, rekursiv `image:image`, `barcode:barcode`, `table:table`, `table:cell`, darin `text:text` und `datetime:datetime` sowie top-level `text:text`.
- `pt:expanded/@objectName` wird als `name` erhalten. `setObject`/`setObjects` ersetzen Text, Barcode und Datum.
- Ressourcen (`jpg`, `jpeg`, `png`, `bmp`) werden als `Uint8Array` mit MIME-Typ gespeichert.
- Unbekannte direkte oder rekursive Objekte bleiben als `unknown` mit `rawXml` erhalten und erzeugen Warnungen mit XML-Tag und Pfad; bekannte Kinder darin werden weiterhin gerendert.
- Vor dem Entpacken wird das ZIP-Zentralverzeichnis geprüft: keine absoluten/`..`-Pfade, keine Verschlüsselung/ZIP64/Multi-Disk-Archive sowie feste Grenzen für Eintragszahl, komprimierte Größe, Einzeldateien, XML und expandierte Gesamtgröße.

### SVG

Die Ausgabe verwendet LBX-Punkte (`1 pt = 1/72 inch`) im ViewBox, unterstützt Text, UTF-8/XML-Escaping, Bilder als Data-URL, CODE39, Datum, Tabellenrahmen/Zelltexte und Objektrotation. Bei Landscape-Vorlagen werden Bandbreite und Etikettenlänge korrekt auf die SVG-Achsen abgebildet; bei `autoLength=true` wird die riesige P-touch-Platzhalterlänge durch den tatsächlichen Objektumfang plus Nachlauf ersetzt. Der MVP verwendet SVG-Schriftfallbacks; pixelgenaue Brother-/Windows-Schriftmetriken sind nicht garantiert.

### Node-PNG und QL-Raster

`brother-lbx-web/node` nutzt `@resvg/resvg-js` für PNG und `sharp` zur Umwandlung in RGBA-`RawImageData`. Eingebettete 24-/32-Bit-BMP-Ressourcen werden vor der resvg-Rasterisierung über `bmp-js` nach RGBA/PNG normalisiert; unbenutzte Null-Alpha-Paddingbytes werden dabei als opak behandelt. Die Rasterjob-Erzeugung nutzt `@thermal-label/brother-ql-core@0.6.1` und dessen registriertes QL-62-mm-Medium. Unbekannte Druckermodelle oder Media-IDs werden abgelehnt statt still auf Defaults zu fallen. Der Rasterjob ist offline testbar und enthält keine USB- oder TCP-Seiteneffekte.

### Browser/WebUSB

Der Parser und SVG-Renderer benötigen keine Node-`fs`-/USB-Module. `brother-lbx-web/browser` exportiert `connectBrotherQlWebUsb`, das `@thermal-label/brother-ql-web` erst bei Aufruf lazy importiert:

```ts
import { connectBrotherQlWebUsb } from 'brother-lbx-web/browser';
const printer = await connectBrotherQlWebUsb(); // user gesture + HTTPS/localhost
```

WebUSB funktioniert praktisch in Chromium-basierten Browsern, in einem sicheren Kontext und nach einer Benutzeraktion. Firefox/Safari und nicht unterstützte Plattformen benötigen eine lokale Bridge bzw. Node-Transport. Geräteberechtigung, Treiber-/OS-Unterstützung und Medienlage müssen separat geprüft werden.

## MVP-Grenzen

Noch nicht vollständig unterstützt sind freie Zeichnungsobjekte, komplexe Rich-Text-Layouts, Clips, alle Barcode-Protokolle außer CODE39-Fallback, Brother-Schriftmetriken und realer Hardwaretransport. Nicht unterstützte XML-Objekte werden jedoch gemeldet statt still verworfen.

## Tests und Fixture-Herkunft

```bash
npm test
npm run build
```

Die reale Fixture `test/fixtures/template.lbx` stammt unverändert aus [`yeasir01/bpac-js`](https://github.com/yeasir01/bpac-js), fest auf Commit `20b299012d49550d398085b312fd54748d6020a9` gepinnt. Sie enthält ein QL-820NWB-Layout mit JPEG, CODE39-Barcode und verschachtelter Tabelle und wird nur als Testdaten verwendet; keine GPL-Quelle wird eingebunden.

Zusätzlich laufen End-to-End-Tests gegen zwei öffentlich aus dem Internet bezogene LBX-Dateien aus [`jdlien/lbx-utils`](https://github.com/jdlien/lbx-utils), fest auf Commit `2600c2c2361eb54dc0c4c404d0646494eb99147b` gepinnt:

- `default-text-only-12mm.lbx` – Landscape/AutoLength/Text
- `single_image.lbx` – eingebettetes 32-Bit-BMP

Die Tests validieren Parser, SVG-Abmessungen, sichtbare PNG-Pixel und Brother-Rasterbefehle. URLs und SHA-256-Prüfsummen stehen in `test/fixtures/README.md`.
