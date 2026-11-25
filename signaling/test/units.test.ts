import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DEFAULT_STATIC_DIR, DEFAULT_STUN, loadConfig } from '../src/config.ts';
import { WindowCounter } from '../src/rate-limit.ts';
import { buildIceConfig, turnRestCredentials } from '../src/turn.ts';

test('loadConfig: valores padrão', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.wsPath, '/ws');
  assert.equal(c.staticDir, DEFAULT_STATIC_DIR);
  assert.deepEqual(c.stunUrls, [DEFAULT_STUN]);
  assert.equal(c.turn, null);
  assert.equal(c.allowedOrigins, null);
  assert.equal(c.iceTransportPolicy, 'all');
  assert.equal(c.downloadUrl, null);
});

test('loadConfig: DOWNLOAD_URL só https', () => {
  const url = 'https://github.com/u/remoto/releases/latest/download/remoto-agent.exe';
  assert.equal(loadConfig({ DOWNLOAD_URL: url }).downloadUrl, url);
  assert.throws(() => loadConfig({ DOWNLOAD_URL: 'http://x.example/a.exe' }), /DOWNLOAD_URL/);
  assert.throws(() => loadConfig({ DOWNLOAD_URL: 'javascript:alert(1)' }), /DOWNLOAD_URL/);
  assert.throws(() => loadConfig({ DOWNLOAD_URL: 'nao é url' }), /DOWNLOAD_URL/);
});

test('loadConfig: PORT, HOST e listas vindas do ambiente', () => {
  const c = loadConfig({
    PORT: '9000',
    HOST: '127.0.0.1',
    STUN_URLS: '',
    STATIC_DIR: '',
    ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    TURN_URLS: 'turn:t.example:3478,turns:t.example:5349',
    TURN_USERNAME: 'u',
    TURN_CREDENTIAL: 'p',
    ICE_TRANSPORT_POLICY: 'relay',
  });
  assert.equal(c.port, 9000);
  assert.equal(c.host, '127.0.0.1');
  assert.deepEqual(c.stunUrls, []);
  assert.equal(c.staticDir, null);
  assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(c.turn?.urls, ['turn:t.example:3478', 'turns:t.example:5349']);
  assert.equal(c.iceTransportPolicy, 'relay');
});

test('loadConfig: erros claros para valores inválidos', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ WS_PATH: 'ws' }), /WS_PATH/);
  assert.throws(() => loadConfig({ STUN_URLS: 'http://x' }), /STUN/);
  assert.throws(() => loadConfig({ TURN_URLS: 'turn:x' }), /TURN_SECRET/);
  assert.throws(() => loadConfig({ TURN_URLS: 'stun:x', TURN_SECRET: 's' }), /TURN/);
  assert.throws(() => loadConfig({ ICE_TRANSPORT_POLICY: 'relay' }), /TURN_URLS/);
  assert.throws(() => loadConfig({ ICE_TRANSPORT_POLICY: 'x' }), /ICE_TRANSPORT_POLICY/);
});

test('credenciais TURN REST: formato, validade e HMAC-SHA1', () => {
  const now = Date.UTC(2026, 0, 1);
  const { username, credential } = turnRestCredentials('segredo', 'host', 3600, now);
  assert.equal(username, `${now / 1000 + 3600}:host`);
  assert.equal(credential, createHmac('sha1', 'segredo').update(username).digest('base64'));
  assert.notEqual(turnRestCredentials('outro', 'host', 3600, now).credential, credential);
});

test('buildIceConfig: STUN + TURN estático', () => {
  const config = loadConfig({ STUN_URLS: 'stun:s.example:3478', TURN_URLS: 'turn:t.example', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.deepEqual(buildIceConfig(config, 'viewer'), {
    iceServers: [{ urls: ['stun:s.example:3478'] }, { urls: ['turn:t.example'], username: 'u', credential: 'p' }],
    iceTransportPolicy: 'all',
  });
});

test('WindowCounter conta por chave dentro da janela', () => {
  const w = new WindowCounter(1000);
  assert.equal(w.count('a', 0), 0);
  assert.equal(w.record('a', 0), 1);
  assert.equal(w.record('a', 500), 2);
  assert.equal(w.count('b', 500), 0);
  assert.equal(w.count('a', 999), 2);
  assert.equal(w.count('a', 1000), 0);
  assert.equal(w.record('a', 1000), 1);
  w.sweep(5000);
  assert.equal(w.size, 0);
});
