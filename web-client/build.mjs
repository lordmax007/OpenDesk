// Gera web-client/dist: copia public/ e empacota src/*.ts com esbuild.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'public'), dist, { recursive: true });

const options = {
  entryPoints: [path.join(root, 'src/viewer.ts'), path.join(root, 'src/host.ts')],
  bundle: true,
  outdir: dist,
  format: 'esm',
  target: 'chrome110',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Observando alterações em web-client/src…');
} else {
  await esbuild.build(options);
}
