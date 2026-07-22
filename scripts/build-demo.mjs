import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'demo-dist');

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'examples'), { recursive: true });
await Promise.all([
  cp(resolve(root, 'demo/index.html'), resolve(output, 'index.html')),
  cp(resolve(root, 'demo/styles.css'), resolve(output, 'styles.css')),
  cp(resolve(root, 'test/fixtures/template.lbx'), resolve(output, 'examples/product-label.lbx')),
  cp(resolve(root, 'artifacts/qr-test-label/qr-test-label.lbx'), resolve(output, 'examples/qr-test-label.lbx')),
  cp(resolve(root, 'test/fixtures/internet/default-text-only-12mm.lbx'), resolve(output, 'examples/text-strip-12mm.lbx')),
]);

await build({
  entryPoints: [resolve(root, 'demo/app.ts')],
  outfile: resolve(output, 'app.js'),
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  format: 'esm',
  target: ['chrome109', 'edge109'],
  legalComments: 'linked',
  banner: { js: '/* LBX Print Bench · browser-only processing */' },
});

console.log(`Demo built at ${output}`);
