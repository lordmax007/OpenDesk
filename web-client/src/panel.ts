/** Painel lateral: chat e transferências de arquivos. */
import { MAX_CHAT_LENGTH, parseChatMessage } from '@remoto/protocol';
import { el } from './dom.ts';
import { FileTransfers, type Link, type TransferEvents, type TransferInfo } from './file-transfer.ts';

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export class SidePanel {
  private readonly side = el('side');
  private readonly toggle = el<HTMLButtonElement>('side-toggle');
  private readonly chatLog = el<HTMLOListElement>('chat-log');
  private readonly chatForm = el<HTMLFormElement>('chat-form');
  private readonly chatInput = el<HTMLInputElement>('chat-input');
  private readonly fileInput = el<HTMLInputElement>('file-input');
  private readonly list = el<HTMLUListElement>('transfers');
  private readonly rows = new Map<string, { li: HTMLLIElement; bar: HTMLProgressElement; status: HTMLSpanElement }>();
  private chat: RTCDataChannel | null = null;
  private unread = 0;
  readonly transfers: FileTransfers;

  constructor(highWater: () => number) {
    this.transfers = new FileTransfers(null, this.events(), highWater);
    this.toggle.addEventListener('click', () => this.show(this.side.hidden));
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput.value.trim().slice(0, MAX_CHAT_LENGTH);
      if (!text || this.chat?.readyState !== 'open') return;
      this.chat.send(JSON.stringify({ t: 'chat', text, at: Date.now() }));
      this.addChat('Você', text, true);
      this.chatInput.value = '';
    });
    this.fileInput.addEventListener('change', () => {
      this.sendFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
  }

  show(on: boolean): void {
    this.side.hidden = !on;
    this.toggle.setAttribute('aria-expanded', String(on));
    if (on) {
      this.unread = 0;
      this.updateToggle();
      this.chatInput.focus();
    }
  }

  setVisible(on: boolean): void {
    this.toggle.hidden = !on;
    if (!on) this.side.hidden = true;
  }

  sendFiles(files: File[]): void {
    if (files.length === 0) return;
    this.show(true);
    for (const f of files) void this.transfers.sendFile(f).catch(() => undefined);
  }

  attachChat(ch: RTCDataChannel): void {
    this.chat = ch;
    ch.addEventListener('message', (ev) => {
      const p = parseChatMessage(ev.data);
      if (p.ok) this.addChat('Computador remoto', p.msg.text, false);
    });
  }

  attachFile(ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 32 * 1024;
    const link: Link = {
      send: (d) => (typeof d === 'string' ? ch.send(d) : ch.send(d as Uint8Array<ArrayBuffer>)),
      bufferedAmount: () => ch.bufferedAmount,
      waitDrain: () =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50); // reavalia (o limite muda com o uso de mouse/teclado)
          ch.addEventListener('bufferedamountlow', () => (clearTimeout(t), resolve()), { once: true });
        }),
    };
    ch.addEventListener('message', (ev) => void this.transfers.handle(ev.data as string | ArrayBuffer));
    ch.addEventListener('close', () => this.transfers.setLink(null));
    this.transfers.setLink(link);
  }

  detach(): void {
    this.chat = null;
    this.transfers.setLink(null);
    this.setVisible(false);
  }

  private addChat(from: string, text: string, mine: boolean): void {
    const li = document.createElement('li');
    li.className = mine ? 'mine' : 'theirs';
    const who = document.createElement('strong');
    who.textContent = `${from}: `;
    li.append(who, document.createTextNode(text)); // texto puro, nunca HTML
    this.chatLog.append(li);
    li.scrollIntoView({ block: 'end' });
    if (!mine && this.side.hidden) {
      this.unread++;
      this.updateToggle();
    }
  }

  private updateToggle(): void {
    this.toggle.textContent = this.unread > 0 ? `Chat e arquivos (${this.unread})` : 'Chat e arquivos';
  }

  private row(t: TransferInfo) {
    let r = this.rows.get(t.id);
    if (!r) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${t.direction === 'out' ? '↑' : '↓'} ${t.name} (${human(t.size)})`;
      const bar = document.createElement('progress');
      bar.max = Math.max(t.size, 1);
      bar.value = 0;
      const status = document.createElement('span');
      status.className = 'status';
      li.append(name, bar, status);
      this.list.prepend(li);
      r = { li, bar, status };
      this.rows.set(t.id, r);
    }
    return r;
  }

  private events(): TransferEvents {
    return {
      onProgress: (t, bytes, resumedFrom) => {
        const r = this.row(t);
        r.bar.value = bytes;
        r.status.textContent = resumedFrom > 0 ? `retomado em ${human(resumedFrom)}` : `${Math.floor((bytes / Math.max(t.size, 1)) * 100)}%`;
      },
      onSent: (t) => {
        const r = this.row(t);
        r.bar.value = r.bar.max;
        r.status.textContent = 'entregue, SHA-256 conferido no destino';
      },
      onReceived: (t, file) => {
        const r = this.row(t);
        r.bar.value = r.bar.max;
        r.status.textContent = 'SHA-256 conferido · ';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        a.textContent = 'Salvar';
        r.status.append(a);
        this.show(true);
      },
      onFailed: (t, reason) => {
        this.row(t).status.textContent = reason;
      },
    };
  }
}
