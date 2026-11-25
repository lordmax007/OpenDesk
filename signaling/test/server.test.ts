import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CLOSE_REPLACED } from '../src/server.ts';
import { TestClient, setup, sleep } from './helpers.ts';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.168.0.10 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };

test('host recebe ID de 9 dígitos, token e configuração ICE', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { reg } = await s.register();
  assert.match(reg.id, /^[1-9]\d{8}$/);
  assert.match(reg.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(reg.ice, { iceServers: [{ urls: ['stun:stun.example.org:3478'] }], iceTransportPolicy: 'all' });
});

test('IDs gerados são distintos', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) ids.add((await s.register()).reg.id);
  assert.equal(ids.size, 20);
});

test('fluxo completo: join, offer, answer e ICE nos dois sentidos', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, reg } = await s.register();
  const viewer = await s.open();

  viewer.send({ type: 'join', v: 1, id: reg.id });
  const joined = await viewer.expect('joined');
  assert.equal(joined.id, reg.id);
  assert.ok(Array.isArray(joined.ice.iceServers));
  await host.expect('peer-joined');

  host.send({ type: 'offer', sdp: SDP, extra: 'descartado' });
  assert.deepEqual(await viewer.next(), { type: 'offer', sdp: SDP });

  viewer.send({ type: 'answer', sdp: SDP });
  assert.deepEqual(await host.next(), { type: 'answer', sdp: SDP });

  host.send({ type: 'ice', candidate: CANDIDATE });
  assert.deepEqual(await viewer.next(), { type: 'ice', candidate: CANDIDATE });
  viewer.send({ type: 'ice', candidate: null });
  assert.deepEqual(await host.next(), { type: 'ice', candidate: null });
});

test('join em ID inexistente → host-not-found', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const viewer = await s.open();
  viewer.send({ type: 'join', v: 1, id: '123456789' });
  await viewer.expectError('host-not-found');
});

test('segundo visualizador recebe host-busy', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { reg } = await s.pair();
  const other = await s.open();
  other.send({ type: 'join', v: 1, id: reg.id });
  await other.expectError('host-busy');
});

test('papéis: visualizador não envia offer, host não envia answer nem join', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, viewer, reg } = await s.pair();
  viewer.send({ type: 'offer', sdp: SDP });
  await viewer.expectError('forbidden');
  host.send({ type: 'answer', sdp: SDP });
  await host.expectError('forbidden');
  host.send({ type: 'join', v: 1, id: reg.id });
  await host.expectError('forbidden');
  host.send({ type: 'register', v: 1 });
  await host.expectError('already-registered');
  viewer.send({ type: 'join', v: 1, id: reg.id });
  await viewer.expectError('already-registered');
  await host.expectNothing();
  await viewer.expectNothing();
});

test('repasse sem sessão → not-paired', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host } = await s.register();
  host.send({ type: 'offer', sdp: SDP });
  await host.expectError('not-paired');
  host.send({ type: 'ice', candidate: null });
  await host.expectError('not-paired');
  host.send({ type: 'bye' });
  await host.expectError('not-paired');
});

test('host recusa: visualizador recebe peer-left refused e pode tentar de novo', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, viewer, reg } = await s.pair();
  host.send({ type: 'bye', reason: 'refused' });
  assert.deepEqual(await viewer.next(), { type: 'peer-left', reason: 'refused' });

  viewer.send({ type: 'offer', sdp: SDP });
  await viewer.expectError('forbidden');
  viewer.send({ type: 'join', v: 1, id: reg.id });
  await viewer.expect('joined');
  await host.expect('peer-joined');
});

test('visualizador encerra (bye) e desconecta: host fica livre', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, viewer, reg } = await s.pair();
  viewer.send({ type: 'bye' });
  assert.deepEqual(await host.next(), { type: 'peer-left', reason: 'ended' });

  viewer.send({ type: 'join', v: 1, id: reg.id });
  await viewer.expect('joined');
  await host.expect('peer-joined');
  viewer.ws.close();
  assert.deepEqual(await host.next(), { type: 'peer-left', reason: 'disconnected' });

  const v2 = await s.open();
  v2.send({ type: 'join', v: 1, id: reg.id });
  await v2.expect('joined');
});

test('host desconecta: visualizador recebe peer-left disconnected e o ID sai do ar', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, viewer, reg } = await s.pair();
  host.ws.close();
  assert.deepEqual(await viewer.next(), { type: 'peer-left', reason: 'disconnected' });
  viewer.send({ type: 'join', v: 1, id: reg.id });
  await viewer.expectError('host-not-found');
});

test('host reconecta com id + token e mantém o ID; token errado é recusado', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, reg } = await s.register();
  host.ws.close();
  await host.closed;
  await sleep(30);

  const intruder = await s.open();
  intruder.send({ type: 'register', v: 1, id: reg.id, token: 'b'.repeat(43) });
  await intruder.expectError('id-unavailable');

  const back = await s.open();
  back.send({ type: 'register', v: 1, id: reg.id, token: reg.token });
  const again = await back.expect('registered');
  assert.equal(again.id, reg.id);
  assert.equal(again.token, reg.token);
});

test('reserva expira: ID volta a ficar livre (TOFU)', async (t) => {
  const s = await setup({ ID_RESERVATION_HOURS: '0' });
  t.after(s.cleanup);
  const { host, reg } = await s.register();
  host.ws.close();
  await host.closed;
  await sleep(30);
  const other = await s.open();
  other.send({ type: 'register', v: 1, id: reg.id, token: 'c'.repeat(43) });
  assert.equal((await other.expect('registered')).id, reg.id);
});

test('mesmo token com host ainda online substitui a conexão antiga', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const { host, viewer, reg } = await s.pair();
  const fresh = await s.open();
  fresh.send({ type: 'register', v: 1, id: reg.id, token: reg.token });
  await fresh.expect('registered');
  assert.deepEqual(await viewer.next(), { type: 'peer-left', reason: 'replaced' });
  assert.equal((await host.closed).code, CLOSE_REPLACED);

  const v2 = await s.open();
  v2.send({ type: 'join', v: 1, id: reg.id });
  await v2.expect('joined');
  await fresh.expect('peer-joined');
  assert.equal(s.server.counts().hosts, 1);
});

test('limite de join com falha por IP fecha a conexão', async (t) => {
  const s = await setup({ JOIN_FAIL_LIMIT: '3' });
  t.after(s.cleanup);
  const viewer = await s.open();
  for (let i = 0; i < 3; i++) {
    viewer.send({ type: 'join', v: 1, id: '111111111' });
    await viewer.expectError('host-not-found');
  }
  viewer.send({ type: 'join', v: 1, id: '111111111' });
  await viewer.expectError('rate-limited');
  assert.equal((await viewer.closed).code, 1008);

  // o limite é por IP, não por conexão
  const again = await s.open();
  again.send({ type: 'join', v: 1, id: '111111111' });
  await again.expectError('rate-limited');
});

test('excesso de mensagens fecha a conexão', async (t) => {
  const s = await setup({ MSG_RATE_LIMIT: '20' });
  t.after(s.cleanup);
  const c = await s.open();
  for (let i = 0; i < 25; i++) c.send({ type: 'bye' });
  const { code } = await c.closed;
  assert.equal(code, 1008);
});

test('mensagens inválidas não derrubam a conexão', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const c = await s.open();
  c.send('não é json');
  await c.expectError('bad-message');
  c.send({ type: 'register' });
  await c.expectError('unsupported-version');
  c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  await c.expectError('bad-message');
  c.send({ type: 'register', v: 1 });
  await c.expect('registered');
});

test('mensagem acima de 64 KiB derruba a conexão (1009)', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const c = await s.open();
  c.send({ type: 'offer', sdp: 'x'.repeat(70_000) });
  assert.equal((await c.closed).code, 1009);
});

test('ALLOWED_ORIGINS: origem desconhecida é recusada, sem Origin é aceita', async (t) => {
  const s = await setup({ ALLOWED_ORIGINS: 'https://remoto.example.org' });
  t.after(s.cleanup);
  await assert.rejects(TestClient.open(s.url, { Origin: 'https://evil.example' }), /HTTP 403/);
  const ok = await s.open({ Origin: 'https://remoto.example.org' });
  ok.send({ type: 'register', v: 1 });
  await ok.expect('registered');
  const native = await s.open();
  native.send({ type: 'register', v: 1 });
  await native.expect('registered');
});

test('caminho de WebSocket errado é recusado', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await assert.rejects(TestClient.open(s.url.replace('/ws', '/outro')), /HTTP 404/);
});

test('TURN com segredo gera credenciais temporárias por conexão', async (t) => {
  const s = await setup({ TURN_URLS: 'turn:turn.example.org:3478', TURN_SECRET: 'segredo' });
  t.after(s.cleanup);
  const { reg } = await s.register();
  const turn = reg.ice.iceServers[1];
  assert.deepEqual(turn.urls, ['turn:turn.example.org:3478']);
  assert.match(turn.username, /^\d+:host$/);
  assert.equal(typeof turn.credential, 'string');
  assert.ok(!JSON.stringify(reg).includes('segredo'), 'o segredo nunca deve sair do servidor');
});

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

function rawGet(port: number, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: /healthz, arquivos estáticos, cabeçalhos de segurança e path traversal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'remoto-static-'));
  await mkdir(path.join(dir, 'public'));
  await writeFile(path.join(dir, 'public', 'index.html'), '<h1>ok</h1>');
  await writeFile(path.join(dir, 'segredo.txt'), 'não deveria vazar');
  const s = await setup({ STATIC_DIR: path.join(dir, 'public') });
  t.after(s.cleanup);

  assert.equal((await get(`${s.base}/healthz`)).body, 'ok');

  const index = await get(`${s.base}/`);
  assert.equal(index.status, 200);
  assert.equal(index.body, '<h1>ok</h1>');
  assert.match(String(index.headers['content-type']), /text\/html/);
  assert.match(String(index.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');

  assert.equal((await get(`${s.base}/nao-existe.js`)).status, 404);
  for (const p of ['/../segredo.txt', '/%2e%2e/segredo.txt', '/..%2fsegredo.txt', '/..%5csegredo.txt']) {
    const status = await rawGet(s.server.port, p);
    assert.ok(status === 403 || status === 404, `${p} → ${status}`);
  }
});

test('/baixar: redireciona para DOWNLOAD_URL; sem ela, não existe', async (t) => {
  const url = 'https://github.com/u/remoto/releases/latest/download/remoto-agent.exe';
  const s = await setup({ DOWNLOAD_URL: url, STATIC_DIR: '' });
  t.after(s.cleanup);
  const r = await get(`${s.base}/baixar`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, url);
  const s2 = await setup({ STATIC_DIR: '' });
  t.after(s2.cleanup);
  assert.equal((await get(`${s2.base}/baixar`)).status, 404);
});