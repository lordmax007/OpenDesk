import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}

const server = await startServer(config);
const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
const base = `http://${shownHost}:${server.port}`;

console.log(`Sinalização ouvindo em ${config.host}:${server.port} (WebSocket em ${config.wsPath})`);
console.log(`ICE: STUN=${config.stunUrls.join(', ') || '(nenhum)'} · TURN=${config.turn ? config.turn.urls.join(', ') : '(nenhum)'}`);
if (config.staticDir) {
  if (existsSync(path.join(config.staticDir, 'index.html'))) {
    console.log(`Visualizador: ${base}/`);
    console.log(`Host (protótipo): ${base}/host.html`);
  } else {
    console.warn(`Aviso: ${config.staticDir} não tem index.html. Rode "npm run build" na raiz do projeto.`);
  }
}

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
