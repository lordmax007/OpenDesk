import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=(), geolocation=()',
};

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(text);
}

/** Serve arquivos de `root` com proteção contra path traversal. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    plain(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    plain(res, 400, 'Requisição inválida');
    return;
  }
  if (rel.includes('\0')) {
    plain(res, 400, 'Requisição inválida');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, '.' + path.sep + rel);
  if (!file.startsWith(rootAbs + path.sep)) {
    plain(res, 403, 'Proibido');
    return;
  }

  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('não é arquivo');
    size = st.size;
  } catch {
    plain(res, 404, 'Não encontrado');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
