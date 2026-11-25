import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  LIMITS,
  encode,
  parseClientMessage,
  type ByeMessage,
  type ErrorCode,
  type JoinMessage,
  type PeerLeftReason,
  type RegisterMessage,
  type RelayMessage,
  type ServerMessage,
} from '@remoto/protocol';
import type { Config } from './config.ts';
import { WindowCounter } from './rate-limit.ts';
import { SECURITY_HEADERS, serveStatic } from './static.ts';
import { buildIceConfig } from './turn.ts';

/** Código de fechamento quando outra conexão assume o mesmo ID de host. */
export const CLOSE_REPLACED = 4001;

interface Conn {
  ws: WebSocket;
  ip: string;
  role: 'none' | 'host' | 'viewer';
  hostId: string | null;
  peer: Conn | null;
  alive: boolean;
  closed: boolean;
  windowStart: number;
  windowCount: number;
}

interface Reservation {
  tokenHash: Buffer;
  /** Infinity enquanto o host estiver online. */
  expiresAt: number;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
  counts(): { connections: number; hosts: number; reservations: number };
}

export interface ServerOptions {
  log?: (line: string) => void;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(config: Config, options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));

  const conns = new Set<Conn>();
  const hosts = new Map<string, Conn>();
  const reservations = new Map<string, Reservation>();
  const joinFailures = new WindowCounter(config.joinFailWindowMs);

  // ------------------------------------------------------------ HTTP

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }
    if (url.pathname === '/baixar' && config.downloadUrl && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(302, { Location: config.downloadUrl, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    if (config.staticDir) {
      serveStatic(req, res, config.staticDir, url.pathname);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Não encontrado');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== config.wsPath) return rejectUpgrade(socket, 404, 'Not Found');
    const origin = req.headers.origin;
    // Sem Origin = cliente não-navegador (agente nativo): permitido.
    if (origin && config.allowedOrigins && !config.allowedOrigins.includes(origin)) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      config.trustProxy && typeof forwarded === 'string' && forwarded
        ? forwarded.split(',')[0]!.trim()
        : (req.socket.remoteAddress ?? 'desconhecido');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  // ------------------------------------------------------------ utilidades

  function send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encode(msg));
  }

  function sendError(conn: Conn, code: ErrorCode, message: string): void {
    send(conn, { type: 'error', code, message });
  }

  function fatal(conn: Conn, code: ErrorCode, message: string): void {
    sendError(conn, code, message);
    conn.ws.close(1008, code);
  }

  function liveReservation(id: string, now: number): Reservation | undefined {
    const r = reservations.get(id);
    if (r && r.expiresAt <= now) {
      reservations.delete(id);
      return undefined;
    }
    return r;
  }

  function generateId(now: number): string {
    for (let i = 0; i < 100; i++) {
      const id = String(randomInt(100_000_000, 1_000_000_000));
      if (!hosts.has(id) && !liveReservation(id, now)) return id;
    }
    throw new Error('não foi possível gerar um ID livre');
  }

  /** Desfaz o par e avisa a outra ponta. */
  function unpair(conn: Conn, reasonForPeer: PeerLeftReason): void {
    const peer = conn.peer;
    if (!peer) return;
    conn.peer = null;
    peer.peer = null;
    if (conn.role === 'viewer') conn.hostId = null;
    if (peer.role === 'viewer') peer.hostId = null;
    send(peer, { type: 'peer-left', reason: reasonForPeer });
    log(`sessão encerrada (${reasonForPeer})`);
  }

  /** Tira o host do ar e mantém o ID reservado pelo TTL configurado. */
  function detachHost(host: Conn, reason: PeerLeftReason): void {
    unpair(host, reason);
    const id = host.hostId;
    if (id && hosts.get(id) === host) {
      hosts.delete(id);
      const r = reservations.get(id);
      if (r) r.expiresAt = Date.now() + config.idReservationTtlMs;
      log(`host offline ${id}`);
    }
  }

  // ------------------------------------------------------------ handlers

  function handleRegister(conn: Conn, msg: RegisterMessage): void {
    if (conn.role !== 'none') return sendError(conn, 'already-registered', 'Esta conexão já tem um papel');
    const now = Date.now();
    let id: string;
    let token: string;

    if (msg.id !== undefined && msg.token !== undefined) {
      const res = liveReservation(msg.id, now);
      const hash = sha256(msg.token);
      if (res && !timingSafeEqual(res.tokenHash, hash)) {
        return sendError(conn, 'id-unavailable', 'ID em uso ou reservado');
      }
      const old = hosts.get(msg.id);
      if (old) {
        detachHost(old, 'replaced');
        old.closed = true;
        old.ws.close(CLOSE_REPLACED, 'replaced');
      }
      id = msg.id;
      token = msg.token;
    } else {
      id = generateId(now);
      token = randomBytes(32).toString('base64url');
    }

    reservations.set(id, { tokenHash: sha256(token), expiresAt: Infinity });
    conn.role = 'host';
    conn.hostId = id;
    hosts.set(id, conn);
    send(conn, { type: 'registered', id, token, ice: buildIceConfig(config, 'host') });
    log(`host online ${id}`);
  }

  function handleJoin(conn: Conn, msg: JoinMessage): void {
    if (conn.role === 'host') return sendError(conn, 'forbidden', 'Um host não pode entrar em outra sessão');
    if (conn.peer) return sendError(conn, 'already-registered', 'Esta conexão já está em uma sessão');
    if (joinFailures.count(conn.ip) >= config.joinFailLimit) {
      return fatal(conn, 'rate-limited', 'Muitas tentativas. Aguarde e tente novamente.');
    }
    const host = hosts.get(msg.id);
    if (!host) {
      joinFailures.record(conn.ip);
      return sendError(conn, 'host-not-found', 'ID não encontrado ou offline');
    }
    if (host.peer) return sendError(conn, 'host-busy', 'Este computador já está em uma sessão');

    conn.role = 'viewer';
    conn.hostId = msg.id;
    conn.peer = host;
    host.peer = conn;
    send(conn, { type: 'joined', id: msg.id, ice: buildIceConfig(config, 'viewer') });
    send(host, { type: 'peer-joined' });
    log(`sessão iniciada com ${msg.id}`);
  }

  function relay(conn: Conn, msg: RelayMessage): void {
    if (msg.type === 'offer' && conn.role !== 'host') {
      return sendError(conn, 'forbidden', 'Somente o host envia offer');
    }
    if (msg.type === 'answer' && conn.role !== 'viewer') {
      return sendError(conn, 'forbidden', 'Somente o visualizador envia answer');
    }
    if (!conn.peer) return sendError(conn, 'not-paired', 'Nenhuma sessão ativa');
    send(conn.peer, msg);
  }

  function handleBye(conn: Conn, msg: ByeMessage): void {
    if (!conn.peer) return sendError(conn, 'not-paired', 'Nenhuma sessão ativa');
    unpair(conn, msg.reason);
  }

  function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.closed) return;
    const now = Date.now();
    if (now - conn.windowStart >= config.msgRateWindowMs) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    if (++conn.windowCount > config.msgRateLimit) return fatal(conn, 'rate-limited', 'Muitas mensagens');
    if (isBinary) return sendError(conn, 'bad-message', 'Mensagens binárias não são aceitas');

    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) return sendError(conn, parsed.code, parsed.error);
    const msg = parsed.msg;
    try {
      switch (msg.type) {
        case 'register':
          return handleRegister(conn, msg);
        case 'join':
          return handleJoin(conn, msg);
        case 'bye':
          return handleBye(conn, msg);
        default:
          return relay(conn, msg);
      }
    } catch (err) {
      log(`erro interno: ${(err as Error).message}`);
      sendError(conn, 'internal', 'Erro interno');
    }
  }

  function onClose(conn: Conn): void {
    conns.delete(conn);
    if (conn.closed) return;
    conn.closed = true;
    if (conn.role === 'host') detachHost(conn, 'disconnected');
    else if (conn.role === 'viewer') unpair(conn, 'disconnected');
  }

  function onConnection(ws: WebSocket, ip: string): void {
    const conn: Conn = {
      ws,
      ip,
      role: 'none',
      hostId: null,
      peer: null,
      alive: true,
      closed: false,
      windowStart: Date.now(),
      windowCount: 0,
    };
    conns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('close', () => onClose(conn));
    ws.on('error', () => {
      /* 'close' vem em seguida */
    });
  }

  // ------------------------------------------------------------ manutenção

  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
    const now = Date.now();
    for (const [id, r] of reservations) if (r.expiresAt <= now) reservations.delete(id);
    joinFailures.sweep(now);
  }, config.heartbeatMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    port: (httpServer.address() as AddressInfo).port,
    counts: () => ({ connections: conns.size, hosts: hosts.size, reservations: reservations.size }),
    close: async () => {
      clearInterval(timer);
      for (const c of conns) c.ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
