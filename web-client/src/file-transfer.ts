/**
 * Transferência de arquivos pelo canal "file" (Etapa 4) — ver docs/arquitetura.md §13.
 * Independente do DOM e do WebRTC (recebe um `Link`), para ser testada no Node.
 */
import { parseFileMessage, type FileMessage } from '@remoto/protocol';
import { sha256Blob } from './sha256.ts';

export const CHUNK = 16 * 1024;
export const HEADER = 13;
const MAGIC = 0x46;
const READ_BLOCK = 1024 * 1024;

export function encodeChunk(n: number, offset: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + data.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, MAGIC);
  v.setUint32(1, n);
  v.setBigUint64(5, BigInt(offset));
  out.set(data, HEADER);
  return out;
}

export function decodeChunk(buf: ArrayBuffer | Uint8Array): { n: number; offset: number; data: Uint8Array } | null {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < HEADER || u[0] !== MAGIC) return null;
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  return { n: v.getUint32(1), offset: Number(v.getBigUint64(5)), data: u.subarray(HEADER) };
}

export interface Link {
  send(data: string | Uint8Array): void;
  bufferedAmount(): number;
  /** Resolve quando a fila esvazia (ou após um tempo, para reavaliar). */
  waitDrain(): Promise<void>;
}

export interface TransferInfo {
  id: string;
  name: string;
  size: number;
  direction: 'in' | 'out';
}

export interface TransferEvents {
  onProgress?(t: TransferInfo, bytes: number, resumedFrom: number): void;
  onReceived?(t: TransferInfo, file: File): void;
  onSent?(t: TransferInfo): void;
  onFailed?(t: TransferInfo, reason: string): void;
}

interface Part {
  blobs: Blob[];
  pending: Uint8Array[];
  pendingBytes: number;
  received: number;
}

interface Incoming extends TransferInfo {
  n: number;
  sha256: string;
  key: string;
}

interface Outgoing extends TransferInfo {
  waiter: { resolve: (v: FileMessage) => void } | null;
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class FileTransfers {
  /** Partes recebidas por conteúdo (sha256:tamanho): sobrevivem a quedas enquanto a aba existir. */
  private parts = new Map<string, Part>();
  private incoming: Incoming | null = null;
  private outgoing = new Map<string, Outgoing>();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private n = 1;

  constructor(
    private link: Link | null,
    private readonly events: TransferEvents = {},
    /** Limite da fila de envio (bytes): menor enquanto o usuário usa mouse/teclado. */
    private readonly highWater: () => number = () => 1024 * 1024,
  ) {}

  setLink(link: Link | null): void {
    if (link === null) this.disconnect();
    this.link = link;
  }

  /** Conexão caiu: interrompe o que está em curso, guarda o que já chegou. */
  disconnect(): void {
    this.generation++;
    if (this.incoming) {
      this.flush(this.parts.get(this.incoming.key));
      this.events.onFailed?.(this.incoming, 'conexão perdida (a parte recebida fica guardada)');
      this.incoming = null;
    }
    for (const o of this.outgoing.values()) o.waiter?.resolve({ t: 'file-cancel', id: o.id });
    this.outgoing.clear();
  }

  /** Envia um arquivo; um por vez (os demais esperam na fila). */
  sendFile(file: File): Promise<void> {
    const run = this.queue.then(() => this.doSend(file));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doSend(file: File): Promise<void> {
    const gen = this.generation;
    const info: Outgoing = { id: randomId(), name: file.name, size: file.size, direction: 'out', waiter: null };
    const fail = (reason: string) => {
      this.events.onFailed?.(info, reason);
      throw new Error(reason);
    };
    const sha256 = await sha256Blob(file);
    const link = this.link;
    if (!link || gen !== this.generation) return fail('sem conexão');
    this.outgoing.set(info.id, info);
    const n = this.n++;
    const reply = this.wait(info, () => link.send(JSON.stringify({ t: 'file-offer', id: info.id, n, name: file.name, size: file.size, sha256 })));
    const answer = await reply;
    if (answer.t !== 'file-accept') {
      this.outgoing.delete(info.id);
      return fail(answer.t === 'file-reject' ? answer.reason : 'cancelado');
    }
    const resumedFrom = answer.offset;
    let offset = resumedFrom;
    while (offset < file.size) {
      const block = new Uint8Array(await file.slice(offset, Math.min(offset + READ_BLOCK, file.size)).arrayBuffer());
      for (let i = 0; i < block.length; i += CHUNK) {
        while (link.bufferedAmount() > this.highWater()) {
          await link.waitDrain();
          if (gen !== this.generation) return fail('conexão perdida (ofereça de novo para retomar)');
        }
        if (gen !== this.generation) return fail('conexão perdida (ofereça de novo para retomar)');
        const piece = block.subarray(i, i + CHUNK);
        link.send(encodeChunk(n, offset, piece));
        offset += piece.length;
      }
      this.events.onProgress?.(info, offset, resumedFrom);
    }
    const done = await this.wait(info, () => link.send(JSON.stringify({ t: 'file-end', id: info.id })));
    this.outgoing.delete(info.id);
    if (done.t === 'file-done' && done.ok) {
      this.events.onSent?.(info);
      return;
    }
    return fail(done.t === 'file-done' ? `falhou no destino (${done.reason ?? '?'})` : 'cancelado');
  }

  private wait(o: Outgoing, send: () => void): Promise<FileMessage> {
    return new Promise((resolve) => {
      o.waiter = { resolve };
      send();
    });
  }

  /** Mensagem recebida no canal "file" (texto = controle, binário = dados). */
  async handle(data: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (typeof data !== 'string') {
      this.onChunk(data);
      return;
    }
    const p = parseFileMessage(data);
    if (!p.ok) return;
    const m = p.msg;
    switch (m.t) {
      case 'file-offer':
        return this.onOffer(m);
      case 'file-end':
        return this.onEnd(m.id);
      case 'file-cancel': {
        if (this.incoming?.id === m.id) {
          this.flush(this.parts.get(this.incoming.key));
          this.events.onFailed?.(this.incoming, 'cancelado pelo outro lado');
          this.incoming = null;
        }
        this.outgoing.get(m.id)?.waiter?.resolve(m);
        return;
      }
      default: {
        const o = this.outgoing.get(m.id);
        const w = o?.waiter;
        if (o) o.waiter = null;
        w?.resolve(m);
      }
    }
  }

  private send(msg: FileMessage): void {
    this.link?.send(JSON.stringify(msg));
  }

  private onOffer(m: Extract<FileMessage, { t: 'file-offer' }>): void {
    if (this.incoming) {
      this.send({ t: 'file-reject', id: m.id, reason: 'ocupado com outra transferência' });
      return;
    }
    const key = `${m.sha256}:${m.size}`;
    let part = this.parts.get(key);
    if (!part) {
      part = { blobs: [], pending: [], pendingBytes: 0, received: 0 };
      this.parts.set(key, part);
    }
    this.incoming = { id: m.id, name: m.name, size: m.size, direction: 'in', n: m.n, sha256: m.sha256, key };
    this.send({ t: 'file-accept', id: m.id, offset: part.received });
    this.events.onProgress?.(this.incoming, part.received, part.received);
  }

  private onChunk(data: ArrayBuffer | Uint8Array): void {
    const inc = this.incoming;
    const c = decodeChunk(data);
    const part = inc ? this.parts.get(inc.key) : undefined;
    if (!inc || !part || !c || c.n !== inc.n || c.offset !== part.received || part.received + c.data.length > inc.size) {
      if (inc) {
        this.send({ t: 'file-cancel', id: inc.id });
        this.flush(part);
        this.events.onFailed?.(inc, 'bloco inesperado');
        this.incoming = null;
      }
      return;
    }
    part.pending.push(c.data.slice());
    part.pendingBytes += c.data.length;
    part.received += c.data.length;
    if (part.pendingBytes >= READ_BLOCK) this.flush(part);
    if (part.received % READ_BLOCK === 0) this.events.onProgress?.(inc, part.received, 0);
  }

  /** Junta os blocos pendentes num Blob (o navegador pode guardar Blobs grandes em disco). */
  private flush(part: Part | undefined): void {
    if (!part || part.pending.length === 0) return;
    part.blobs.push(new Blob(part.pending as BlobPart[]));
    part.pending = [];
    part.pendingBytes = 0;
  }

  private async onEnd(id: string): Promise<void> {
    const inc = this.incoming;
    if (!inc || inc.id !== id) return;
    this.incoming = null;
    const part = this.parts.get(inc.key)!;
    this.flush(part);
    const blob = new Blob(part.blobs);
    this.parts.delete(inc.key);
    const ok = blob.size === inc.size && (await sha256Blob(blob)) === inc.sha256;
    if (!ok) {
      this.send({ t: 'file-done', id, ok: false, reason: 'sha256' });
      this.events.onFailed?.(inc, 'SHA-256 não confere: arquivo descartado');
      return;
    }
    this.send({ t: 'file-done', id, ok: true });
    this.events.onReceived?.(inc, new File([blob], inc.name));
  }
}
