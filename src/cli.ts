#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseLBX, setObject, walkObjects } from './parser.js';
import { renderToSvg } from './svg.js';
import { pngToQlRasterJob, renderSvgToPng } from './node.js';

const USAGE = 'Usage: lbx-render input.lbx --svg out.svg [--png out.png] [--raster out.bin] [--json report.json] [--set name=value]';

function usage(code = 2): never {
  (code === 0 ? console.log : console.error)(USAGE);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) usage(0);
  if (!argv.length || argv[0].startsWith('-')) usage();
  const input = argv[0];
  const result: { input: string; svg?: string; png?: string; raster?: string; json?: string; sets: Array<[string, string]> } = { input, sets: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--svg' && argv[i + 1]) result.svg = argv[++i];
    else if (arg === '--png' && argv[i + 1]) result.png = argv[++i];
    else if (arg === '--raster' && argv[i + 1]) result.raster = argv[++i];
    else if (arg === '--json' && argv[i + 1]) result.json = argv[++i];
    else if (arg === '--set' && argv[i + 1]) {
      const pair = argv[++i];
      const split = pair.indexOf('=');
      if (split < 1) usage();
      result.sets.push([pair.slice(0, split), pair.slice(split + 1)]);
    } else usage();
  }
  if (!result.svg && !result.png && !result.raster && !result.json) usage();
  return result;
}

const args = parseArgs(process.argv.slice(2));
const document = parseLBX(new Uint8Array(await readFile(args.input)));
for (const [name, value] of args.sets) {
  if (!setObject(document, name, value)) console.warn(`warning: no bindable object named ${name}`);
}
const svg = renderToSvg(document);
if (args.svg) await writeFile(args.svg, svg, 'utf8');
const png = args.png || args.raster ? await renderSvgToPng(svg, { dpi: 300 }) : undefined;
if (args.png && png) await writeFile(args.png, png);
if (args.raster && png) await writeFile(args.raster, await pngToQlRasterJob(png, { printer: 'QL-820NWB', mediaId: 259 }));
const report = {
  input: basename(args.input),
  paper: document.paper,
  objectCount: [...walkObjects(document)].length,
  objects: [...walkObjects(document)].map((object) => ({ kind: object.kind, name: object.name, tag: object.tag, path: object.path })),
  warnings: document.warnings,
  outputs: { svg: args.svg, png: args.png, raster: args.raster, json: args.json },
};
if (args.json) await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
