// Empacota o servidor num único arquivo (inclui o `ws`): roda com `node dist/main.js`, sem node_modules.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'dist/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // dependências opcionais de desempenho do `ws`: ele funciona sem elas
  external: ['bufferutil', 'utf-8-validate'],
  // o `ws` é CommonJS e usa require(): em ESM é preciso recriá-lo
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
