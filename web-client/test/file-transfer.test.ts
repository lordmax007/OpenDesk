import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHUNK, FileTransfers, decodeChunk, encodeChunk, type Link } from '../src/file-transfer.ts';
import { Sha256, sha256Blob, toHex } from '../src/sha256.ts';

const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function bytes(len: number, seed = 1): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

// ---------------------------------------------------------------- SHA-256

test('SHA-256: vetores do NIST', () => {
  const h = (s: string) => toHex(new Sha256().update(new TextEncoder().encode(s)).digest());
  assert.equal(h(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(h('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    h('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(toHex(new Sha256().update(new Uint8Array(1_000_000).fill(0x61)).digest()), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 incremental = de uma vez, com partes de qualquer tamanho', () => {
  const data = bytes(200_003);
  const expected = nodeSha(data);
  for (const step of [1, 63, 64, 65, 1000, 65536]) {
    const h = new Sha256();
    for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
    assert.equal(toHex(h.digest()), expected, `passo ${step}`);
  }
});

test('SHA-256 de Blob em partes', async () => {
  const data = bytes(9 * 1024 * 1024 + 7);
  assert.equal(await sha256Blob(new Blob([data])), nodeSha(data));
});

// ---------------------------------------------------------------- quadros

test('cabeçalho do bloco: ida e volta (offset acima de 4 GiB)', () => {
  const frame = encodeChunk(7, 5_000_000_000, new Uint8Array([1, 2, 3]));
  assert.equal(frame.length, 13 + 3);
  const d = decodeChunk(frame)!;
  assert.equal(d.n, 7);
  assert.equal(d.offset, 5_000_000_000);
  assert.deepEqual([...d.data], [1, 2, 3]);
  assert.equal(decodeChunk(new Uint8Array([0x46, 0, 0])), null);
  assert.equal(decodeChunk(new Uint8Array(20)), null);
});

// ---------------------------------------------------------------- transferência

interface Wire {
  /** Se definido, cai (para de entregar) depois de N quadros binários. */
  dropAfterChunks?: number;
  /** Corrompe um byte do N-ésimo quadro binário. */
  corruptChunk?: number;
  chunks: number;
  dead: boolean;
}

/** Liga dois lados por uma "rede" em memória (entrega assíncrona, em ordem). */
function connect(a: FileTransfers, b: FileTransfers, wire: Wire): void {
  const make = (to: FileTransfers): Link => ({
    send(data) {
      if (wire.dead) return;
      let d = data;
      if (typeof d !== 'string') {
        wire.chunks++;
        if (wire.dropAfterChunks !== undefined && wire.chunks > wire.dropAfterChunks) {
          wire.dead = true;
          queueMicrotask(() => {
            a.disconnect();
            b.disconnect();
          });
          return;
        }
        if (wire.corruptChunk === wire.chunks) {
          d = d.slice();
          d[20] ^= 0xff;
        }
      }
      const copy = d;
      queueMicrotask(() => void to.handle(copy));
    },
    bufferedAmount: () => 0,
    waitDrain: () => Promise.resolve(),
  });
  a.setLink(make(b));
  b.setLink(make(a));
}

function recorder() {
  const log = { received: [] as File[], failed: [] as string[], sent: 0, resumedFrom: [] as number[] };
  return {
    log,
    events: {
      onReceived: (_t: unknown, f: File) => log.received.push(f),
      onFailed: (_t: unknown, r: string) => log.failed.push(r),
      onSent: () => log.sent++,
      onProgress: (_t: unknown, _b: number, from: number) => from > 0 && log.resumedFrom.push(from),
    },
  };
}

test('transferência completa com integridade (SHA-256 conferido no destino)', async () => {
  const data = bytes(CHUNK * 20 + 999);
  const rx = recorder();
  const sender = new FileTransfers(null);
  const receiver = new FileTransfers(null, rx.events);
  connect(sender, receiver, { chunks: 0, dead: false });
  await sender.sendFile(new File([data], 'relatório.pdf'));
  assert.equal(rx.log.received.length, 1);
  const got = new Uint8Array(await rx.log.received[0]!.arrayBuffer());
  assert.equal(rx.log.received[0]!.name, 'relatório.pdf');
  assert.equal(nodeSha(got), nodeSha(data));
});

test('dado corrompido no caminho: destino detecta, descarta e o envio falha', async () => {
  const data = bytes(CHUNK * 8);
  const rx = recorder();
  const sender = new FileTransfers(null);
  const receiver = new FileTransfers(null, rx.events);
  connect(sender, receiver, { chunks: 0, dead: false, corruptChunk: 3 });
  await assert.rejects(sender.sendFile(new File([data], 'a.bin')), /sha256/);
  assert.equal(rx.log.received.length, 0);
  assert.match(rx.log.failed[0]!, /SHA-256/);
});

test('retomada: a conexão cai no meio e o reenvio continua do offset salvo', async () => {
  const data = bytes(CHUNK * 50 + 123);
  const rx = recorder();
  const receiver = new FileTransfers(null, rx.events);

  // 1ª conexão: cai depois de 30 blocos
  const sender1 = new FileTransfers(null);
  connect(sender1, receiver, { chunks: 0, dead: false, dropAfterChunks: 30 });
  await assert.rejects(sender1.sendFile(new File([data], 'grande.iso')), /conexão perdida|cancelado/);
  assert.equal(rx.log.received.length, 0);

  // 2ª conexão (novo emissor, como após reconectar): retoma
  const sender2 = new FileTransfers(null);
  const tx = recorder();
  const sender2b = new FileTransfers(null, tx.events);
  void sender2;
  connect(sender2b, receiver, { chunks: 0, dead: false });
  await sender2b.sendFile(new File([data], 'grande.iso'));
  assert.equal(rx.log.resumedFrom[0], CHUNK * 30, 'deveria retomar do bloco 30');
  assert.equal(rx.log.received.length, 1);
  assert.equal(nodeSha(new Uint8Array(await rx.log.received[0]!.arrayBuffer())), nodeSha(data));
});

test('arquivo diferente com o mesmo nome não reaproveita parte de outro', async () => {
  const rx = recorder();
  const receiver = new FileTransfers(null, rx.events);
  const s1 = new FileTransfers(null);
  connect(s1, receiver, { chunks: 0, dead: false, dropAfterChunks: 5 });
  await assert.rejects(s1.sendFile(new File([bytes(CHUNK * 10, 1)], 'x.bin')));
  const other = bytes(CHUNK * 10, 2);
  const s2 = new FileTransfers(null);
  connect(s2, receiver, { chunks: 0, dead: false });
  await s2.sendFile(new File([other], 'x.bin'));
  assert.equal(rx.log.resumedFrom.length, 0, 'conteúdo diferente começa do zero');
  assert.equal(nodeSha(new Uint8Array(await rx.log.received[0]!.arrayBuffer())), nodeSha(other));
});

test('arquivo vazio', async () => {
  const rx = recorder();
  const a = new FileTransfers(null);
  const b = new FileTransfers(null, rx.events);
  connect(a, b, { chunks: 0, dead: false });
  await a.sendFile(new File([], 'vazio.txt'));
  assert.equal(rx.log.received[0]!.size, 0);
});

test('vários arquivos em fila, um por vez', async () => {
  const rx = recorder();
  const a = new FileTransfers(null);
  const b = new FileTransfers(null, rx.events);
  connect(a, b, { chunks: 0, dead: false });
  await Promise.all([1, 2, 3].map((i) => a.sendFile(new File([bytes(CHUNK * 3 + i, i)], `f${i}.bin`))));
  assert.deepEqual(rx.log.received.map((f) => f.name), ['f1.bin', 'f2.bin', 'f3.bin']);
});

test('contrapressão: não passa do limite da fila', async () => {
  let buffered = 0;
  let max = 0;
  const b = new FileTransfers(null);
  const a = new FileTransfers(null, {}, () => 64 * 1024);
  a.setLink({
    send(d) {
      if (typeof d !== 'string') {
        buffered += d.length;
        max = Math.max(max, buffered);
      }
      void b.handle(d);
    },
    bufferedAmount: () => buffered,
    waitDrain: async () => {
      buffered = 0; // a "rede" esvaziou a fila
    },
  });
  b.setLink({ send: (d) => void a.handle(d), bufferedAmount: () => 0, waitDrain: async () => {} });
  await a.sendFile(new File([bytes(CHUNK * 40)], 'c.bin'));
  assert.ok(max <= 64 * 1024 + CHUNK + 13, `fila chegou a ${max}`);
});
