import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cliente WebSocket de teste com fila de mensagens recebidas. */
export class TestClient {
  private queue: Msg[] = [];
  private waiters: ((m: Msg) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static open(url: string, headers?: Record<string, string>): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  next(timeoutMs = 2000): Promise<Msg> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = (m: Msg) => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('tempo esgotado esperando mensagem'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async expect(type: string): Promise<Msg> {
    const m = await this.next();
    assert.equal(m.type, type, `esperava "${type}", recebeu ${JSON.stringify(m)}`);
    return m;
  }

  async expectError(code: string): Promise<Msg> {
    const m = await this.expect('error');
    assert.equal(m.code, code, `esperava erro "${code}", recebeu ${JSON.stringify(m)}`);
    return m;
  }

  async expectNothing(ms = 150): Promise<void> {
    await sleep(ms);
    assert.deepEqual(this.queue, [], 'não esperava mensagens');
  }
}

export interface Harness {
  server: RunningServer;
  url: string;
  base: string;
  open(headers?: Record<string, string>): Promise<TestClient>;
  register(extra?: Record<string, unknown>): Promise<{ host: TestClient; reg: Msg }>;
  pair(): Promise<{ host: TestClient; viewer: TestClient; reg: Msg }>;
  cleanup(): Promise<void>;
}

export async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    STATIC_DIR: '',
    STUN_URLS: 'stun:stun.example.org:3478',
    ...env,
  });
  const server = await startServer(config, { log: () => {} });
  const base = `http://127.0.0.1:${server.port}`;
  const url = `ws://127.0.0.1:${server.port}${config.wsPath}`;
  const clients: TestClient[] = [];

  const open = async (headers?: Record<string, string>) => {
    const c = await TestClient.open(url, headers);
    clients.push(c);
    return c;
  };
  const register = async (extra: Record<string, unknown> = {}) => {
    const host = await open();
    host.send({ type: 'register', v: 1, ...extra });
    const reg = await host.expect('registered');
    return { host, reg };
  };
  const pair = async () => {
    const { host, reg } = await register();
    const viewer = await open();
    viewer.send({ type: 'join', v: 1, id: reg.id });
    await viewer.expect('joined');
    await host.expect('peer-joined');
    return { host, viewer, reg };
  };
  const cleanup = async () => {
    for (const c of clients) c.ws.terminate();
    await server.close();
  };
  return { server, url, base, open, register, pair, cleanup };
}
