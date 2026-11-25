import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  encode,
  formatHostId,
  normalizeHostId,
  parseClientMessage,
  parseChatMessage,
  parseControlMessage,
  parseCursorMessage,
  parseFileMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '../src/index.ts';

const ID = '482913075';
const TOKEN = 'a'.repeat(43);
const ICE = { iceServers: [{ urls: ['stun:stun.example.org:3478'] }], iceTransportPolicy: 'all' };

function ok(raw: unknown) {
  const r = parseClientMessage(raw);
  assert.ok(r.ok, `esperava válido: ${JSON.stringify(raw)} → ${!r.ok ? r.error : ''}`);
  return r.msg;
}
function bad(raw: unknown, code = 'bad-message') {
  const r = parseClientMessage(raw);
  assert.ok(!r.ok, `esperava inválido: ${JSON.stringify(raw)}`);
  assert.equal(r.code, code);
}

test('register sem id recebe ID novo', () => {
  assert.deepEqual(ok({ type: 'register', v: 1 }), { type: 'register', v: 1 });
});

test('register com id + token', () => {
  assert.deepEqual(ok({ type: 'register', v: 1, id: ID, token: TOKEN }), {
    type: 'register',
    v: 1,
    id: ID,
    token: TOKEN,
  });
});

test('register exige id e token juntos e com formato válido', () => {
  bad({ type: 'register', v: 1, id: ID });
  bad({ type: 'register', v: 1, token: TOKEN });
  bad({ type: 'register', v: 1, id: '012345678', token: TOKEN }); // zero à esquerda
  bad({ type: 'register', v: 1, id: '12345678', token: TOKEN }); // 8 dígitos
  bad({ type: 'register', v: 1, id: ID, token: 'curto' });
  bad({ type: 'register', v: 1, id: ID, token: 'x'.repeat(42) + '!' });
});

test('versão ausente ou diferente gera unsupported-version', () => {
  bad({ type: 'register' }, 'unsupported-version');
  bad({ type: 'register', v: 2 }, 'unsupported-version');
  bad({ type: 'join', v: '1', id: ID }, 'unsupported-version');
});

test('join valida o ID', () => {
  assert.deepEqual(ok({ type: 'join', v: 1, id: ID }), { type: 'join', v: 1, id: ID });
  bad({ type: 'join', v: 1, id: '482 913 075' });
  bad({ type: 'join', v: 1 });
  bad({ type: 'join', v: 1, id: 482913075 });
});

test('offer/answer validam SDP e limite de tamanho', () => {
  assert.deepEqual(ok({ type: 'offer', sdp: 'v=0' }), { type: 'offer', sdp: 'v=0' });
  assert.deepEqual(ok({ type: 'answer', sdp: 'v=0' }), { type: 'answer', sdp: 'v=0' });
  bad({ type: 'offer' });
  bad({ type: 'offer', sdp: 42 });
  bad({ type: 'answer', sdp: 'x'.repeat(LIMITS.maxSdpLength + 1) });
});

test('ice aceita null, candidato completo e descarta campos extras', () => {
  assert.deepEqual(ok({ type: 'ice', candidate: null }), { type: 'ice', candidate: null });
  const full = { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ab' };
  assert.deepEqual(ok({ type: 'ice', candidate: { ...full, extra: 'x' } }), { type: 'ice', candidate: full });
  assert.deepEqual(ok({ type: 'ice', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null } }), {
    type: 'ice',
    candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null },
  });
});

test('ice rejeita formatos inválidos', () => {
  bad({ type: 'ice' });
  bad({ type: 'ice', candidate: 'texto' });
  bad({ type: 'ice', candidate: { candidate: 'c', sdpMLineIndex: -1 } });
  bad({ type: 'ice', candidate: { candidate: 'c', sdpMLineIndex: 1.5 } });
  bad({ type: 'ice', candidate: { candidate: 'c'.repeat(LIMITS.maxCandidateLength + 1) } });
  bad({ type: 'ice', candidate: { candidate: 'c', sdpMid: 'm'.repeat(65) } });
});

test('bye usa "ended" por padrão e valida o motivo', () => {
  assert.deepEqual(ok({ type: 'bye' }), { type: 'bye', reason: 'ended' });
  assert.deepEqual(ok({ type: 'bye', reason: 'refused' }), { type: 'bye', reason: 'refused' });
  bad({ type: 'bye', reason: 'disconnected' });
});

test('mensagens malformadas', () => {
  bad('{não é json');
  bad('[]');
  bad('null');
  bad('42');
  bad({});
  bad({ type: 7 });
  bad({ type: 'desconhecido' });
  bad('x'.repeat(LIMITS.maxMessageBytes + 1));
});

test('campos extras são descartados', () => {
  assert.deepEqual(ok({ type: 'offer', sdp: 'v=0', from: 'outro', __proto__x: 1 }), { type: 'offer', sdp: 'v=0' });
});

test('cliente não aceita mensagens exclusivas do servidor', () => {
  bad({ type: 'registered', id: ID, token: TOKEN, ice: ICE });
  bad({ type: 'peer-left', reason: 'ended' });
});

test('mensagens do servidor válidas', () => {
  const cases: ServerMessage[] = [
    { type: 'registered', id: ID, token: TOKEN, ice: ICE as never },
    { type: 'joined', id: ID, ice: ICE as never },
    { type: 'peer-joined' },
    { type: 'peer-left', reason: 'replaced' },
    { type: 'error', code: 'host-busy', message: 'ocupado' },
    { type: 'offer', sdp: 'v=0' },
    { type: 'ice', candidate: null },
  ];
  for (const msg of cases) {
    const r = parseServerMessage(encode(msg));
    assert.ok(r.ok, JSON.stringify(msg));
    assert.deepEqual(r.msg, msg);
  }
});

test('configuração ICE: TURN com credenciais, urls como texto e política padrão', () => {
  const r = parseServerMessage({
    type: 'joined',
    id: ID,
    ice: { iceServers: [{ urls: 'turn:t.example.org:3478', username: 'u', credential: 'c' }] },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.msg, {
    type: 'joined',
    id: ID,
    ice: {
      iceServers: [{ urls: ['turn:t.example.org:3478'], username: 'u', credential: 'c' }],
      iceTransportPolicy: 'all',
    },
  });
});

test('configuração ICE inválida é rejeitada', () => {
  const withIce = (ice: unknown) => parseServerMessage({ type: 'joined', id: ID, ice });
  assert.equal(withIce({ iceServers: [{ urls: ['http://evil.example'] }] }).ok, false);
  assert.equal(withIce({ iceServers: [{ urls: [] }] }).ok, false);
  assert.equal(withIce({ iceServers: 'x' }).ok, false);
  assert.equal(withIce({ iceServers: [], iceTransportPolicy: 'none' }).ok, false);
  assert.equal(withIce({ iceServers: Array(LIMITS.maxIceServers + 1).fill({ urls: ['stun:a'] }) }).ok, false);
});

test('servidor: motivos e códigos desconhecidos são rejeitados', () => {
  assert.equal(parseServerMessage({ type: 'peer-left', reason: 'x' }).ok, false);
  assert.equal(parseServerMessage({ type: 'error', code: 'x', message: 'm' }).ok, false);
  assert.equal(parseServerMessage({ type: 'error', code: 'internal' }).ok, false);
});

test('ida e volta: encode → parse preserva todas as mensagens de cliente', () => {
  const cases: ClientMessage[] = [
    { type: 'register', v: 1 },
    { type: 'register', v: 1, id: ID, token: TOKEN },
    { type: 'join', v: 1, id: ID },
    { type: 'offer', sdp: 'v=0\r\n' },
    { type: 'answer', sdp: 'v=0\r\n' },
    { type: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } },
    { type: 'bye', reason: 'refused' },
  ];
  for (const msg of cases) assert.deepEqual(ok(encode(msg)), msg);
});

test('canal de controle: hello', () => {
  const r = parseControlMessage(JSON.stringify({ t: 'hello', role: 'viewer', agent: 'web-client' }));
  assert.ok(r.ok);
  assert.deepEqual(r.msg, { t: 'hello', role: 'viewer', agent: 'web-client' });
  assert.equal(parseControlMessage({ t: 'hello', role: 'admin', agent: 'x' }).ok, false);
  assert.equal(parseControlMessage({ t: 'outro' }).ok, false);
  assert.equal(parseControlMessage({ type: 'hello' }).ok, false);
});

test('canal de controle: mensagens da Etapa 2', () => {
  const info = { t: 'stream-info', encoder: 'Intel Quick Sync', width: 1920, height: 1080, fps: 60, hardware: true, sourceWidth: 1920, sourceHeight: 1080 };
  assert.deepEqual(parseControlMessage(JSON.stringify(info)), { ok: true, msg: info });
  assert.equal(parseControlMessage({ ...info, width: 0 }).ok, false);
  assert.equal(parseControlMessage({ ...info, hardware: 'sim' }).ok, false);

  const shape = { t: 'cursor-shape', id: 3, w: 32, h: 32, hx: 0, hy: 0, png: 'iVBORw0KGgo=' };
  assert.deepEqual(parseControlMessage(shape), { ok: true, msg: shape });
  assert.equal(parseControlMessage({ ...shape, w: 129 }).ok, false);
  assert.equal(parseControlMessage({ ...shape, hx: 40 }).ok, false);
  assert.equal(parseControlMessage({ ...shape, png: '<script>' }).ok, false);
  // imagem do ponteiro pode passar de 64 KiB na mensagem de controle
  assert.equal(parseControlMessage(JSON.stringify({ ...shape, png: 'A'.repeat(100_000) })).ok, true);

  const report = { t: 'latency-report', samples: 600, medianMs: 40, p95Ms: 60, minMs: 30, maxMs: 90, jitterBufferMs: 5, decodeMs: 3, fps: 59.9 };
  assert.deepEqual(parseControlMessage(report), { ok: true, msg: report });
  assert.equal(parseControlMessage({ ...report, medianMs: -1 }).ok, false);
});

test('canal de controle: monitores (Etapa 3)', () => {
  const mons = { t: 'monitors', list: [{ index: 0, name: 'DISPLAY1', width: 1920, height: 1080, primary: true }], current: 0 };
  assert.deepEqual(parseControlMessage(mons), { ok: true, msg: mons });
  assert.equal(parseControlMessage({ ...mons, list: 'x' }).ok, false);
  assert.deepEqual(parseControlMessage({ t: 'select-monitor', index: 1 }), { ok: true, msg: { t: 'select-monitor', index: 1 } });
  assert.equal(parseControlMessage({ t: 'select-monitor', index: -1 }).ok, false);
  assert.deepEqual(parseControlMessage({ t: 'sas', extra: 1 }), { ok: true, msg: { t: 'sas' } }, 'Ctrl+Alt+Del, campos extras descartados');
});

test('acesso com senha (Etapa 5)', () => {
  assert.deepEqual(parseControlMessage({ t: 'auth', password: 'k7m3-xq9p' }), { ok: true, msg: { t: 'auth', password: 'k7m3-xq9p' } });
  assert.equal(parseControlMessage({ t: 'auth', password: 'x'.repeat(129) }).ok, false);
  assert.equal(parseControlMessage({ t: 'auth' }).ok, false);
  assert.deepEqual(parseControlMessage({ t: 'auth-status', status: 'awaiting-consent' }), {
    ok: true,
    msg: { t: 'auth-status', status: 'awaiting-consent' },
  });
  assert.equal(parseControlMessage({ t: 'auth-status', status: 'granted' }).ok, false);
  assert.deepEqual(parseControlMessage({ t: 'auth-result', ok: false, reason: 'wrong-password', attemptsLeft: 2 }), {
    ok: true,
    msg: { t: 'auth-result', ok: false, reason: 'wrong-password', attemptsLeft: 2 },
  });
  assert.deepEqual(parseControlMessage({ t: 'auth-result', ok: false, reason: 'locked', retryAfterS: 60 }), {
    ok: true,
    msg: { t: 'auth-result', ok: false, reason: 'locked', retryAfterS: 60 },
  });
  assert.deepEqual(parseControlMessage({ t: 'auth-result', ok: true }), { ok: true, msg: { t: 'auth-result', ok: true } });
  assert.equal(parseControlMessage({ t: 'auth-result', ok: false, reason: 'outro' }).ok, false);
});

test('chat (Etapa 4)', () => {
  const m = { t: 'chat', text: 'olá', at: 1767225600000 };
  assert.deepEqual(parseChatMessage(JSON.stringify(m)), { ok: true, msg: m });
  assert.equal(parseChatMessage({ ...m, text: 'x'.repeat(4001) }).ok, false);
  assert.equal(parseChatMessage({ t: 'chat', text: 1, at: 0 }).ok, false);
});

test('mensagens de arquivo (Etapa 4)', () => {
  const sha = 'a'.repeat(64);
  const offer = { t: 'file-offer', id: 'ab12', n: 1, name: 'relatório.pdf', size: 1234, sha256: sha };
  assert.deepEqual(parseFileMessage(offer), { ok: true, msg: offer });
  assert.equal(parseFileMessage({ ...offer, sha256: 'A'.repeat(64) }).ok, false);
  assert.equal(parseFileMessage({ ...offer, size: -1 }).ok, false);
  assert.equal(parseFileMessage({ ...offer, id: '../x' }).ok, false);
  assert.deepEqual(parseFileMessage({ t: 'file-accept', id: 'ab12', offset: 32768 }), {
    ok: true,
    msg: { t: 'file-accept', id: 'ab12', offset: 32768 },
  });
  assert.deepEqual(parseFileMessage({ t: 'file-done', id: 'x', ok: false, reason: 'sha256' }), {
    ok: true,
    msg: { t: 'file-done', id: 'x', ok: false, reason: 'sha256' },
  });
  assert.deepEqual(parseFileMessage({ t: 'file-done', id: 'x', ok: true }), { ok: true, msg: { t: 'file-done', id: 'x', ok: true } });
  assert.equal(parseFileMessage({ t: 'file-zip', id: 'x' }).ok, false);
});

test('canal de cursor: posição', () => {
  const pos = { t: 'pos', x: 0.5, y: 0.25, v: true, id: 7 };
  assert.deepEqual(parseCursorMessage(JSON.stringify(pos)), { ok: true, msg: pos });
  assert.equal(parseCursorMessage({ ...pos, x: 5 }).ok, false);
  assert.equal(parseCursorMessage({ ...pos, v: 1 }).ok, false);
  assert.equal(parseCursorMessage({ ...pos, t: 'click' }).ok, false);
});

test('normalizeHostId e formatHostId', () => {
  assert.equal(normalizeHostId(' 482 913-075 '), ID);
  assert.equal(formatHostId(ID), '482 913 075');
  assert.equal(formatHostId('abc'), 'abc');
});
