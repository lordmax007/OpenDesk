/**
 * Envio de mouse e teclado pelo canal "input" (não ordenado, sem retransmissão).
 * Cada mensagem leva o estado completo (posição, botões, teclas) e os eventos do último segundo,
 * numerados: o host aplica cada evento uma vez e reconcilia o estado, então perdas não prendem teclas.
 */
import type { InputEvent, InputMessage } from '@remoto/protocol';
import { contentRect, isSupportedButton, moveRelative, toNormalized, wheelUnits } from './input-map.ts';

const HISTORY_MS = 1000;
const HISTORY_MAX = 32;
const KEEPALIVE_MS = 250;

export class InputSender {
  private channel: RTCDataChannel | null = null;
  private seq = 0;
  private eventSeq = 0;
  private history: { at: number; ev: InputEvent }[] = [];
  private keys = new Set<string>();
  private buttons = 0;
  private x = 0.5;
  private y = 0.5;
  private wheelCarry = { x: 0, y: 0 };
  private resendTimers: number[] = [];
  private keepalive: number | undefined;
  enabled = true;
  /** Chamado a cada movimento local (para desenhar o ponteiro sem esperar a rede). */
  onLocalMove: ((x: number, y: number, inside: boolean) => void) | null = null;
  /** Mouse travado no vídeo (Pointer Lock) ligou ou desligou. */
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly video: HTMLVideoElement) {
    const v = video;
    v.addEventListener('pointermove', (e) => this.onPointer(e));
    v.addEventListener('pointerdown', (e) => this.onPointer(e));
    v.addEventListener('pointerup', (e) => this.onPointer(e));
    v.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    v.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    // botões "voltar/avançar" do mouse não podem navegar a página
    v.addEventListener('mouseup', (e) => this.active && e.button > 2 && e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true), { capture: true });
    window.addEventListener('keyup', (e) => this.onKey(e, false), { capture: true });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      // ao soltar (Esc), nada pode ficar pressionado no computador remoto
      if (!this.locked) this.releaseAll();
      this.onLockChange?.(this.locked);
    });
  }

  /** O mouse está travado dentro do vídeo? */
  get locked(): boolean {
    return document.pointerLockElement === this.video;
  }

  /** Trava o mouse dentro do vídeo (precisa vir de um clique). Esc solta. */
  async lock(): Promise<boolean> {
    if (this.locked) return true;
    try {
      await this.video.requestPointerLock();
      return true;
    } catch {
      return false;
    }
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  attach(channel: RTCDataChannel): void {
    this.channel = channel;
    clearInterval(this.keepalive);
    this.keepalive = window.setInterval(() => {
      if (this.keys.size > 0 || this.buttons !== 0) this.send();
    }, KEEPALIVE_MS);
  }

  detach(): void {
    this.channel = null;
    clearInterval(this.keepalive);
    this.resendTimers.forEach(clearTimeout);
    this.resendTimers = [];
    this.keys.clear();
    this.buttons = 0;
    this.history = [];
  }

  get active(): boolean {
    return this.enabled && this.channel?.readyState === 'open';
  }

  /** Solta tudo (perda de foco, controle desligado). */
  releaseAll(): void {
    if (!this.channel) return;
    // limpa o estado antes: cada mensagem leva o estado, e ele não pode contradizer os eventos
    const keys = [...this.keys];
    const buttons = this.buttons;
    this.keys.clear();
    this.buttons = 0;
    for (const c of keys) this.event({ k: 'ku', n: 0, c });
    for (let b = 0; b <= 4; b++) {
      if (buttons & (1 << b)) this.event({ k: 'mu', n: 0, b, x: this.x, y: this.y });
    }
    this.send();
  }

  private onPointer(e: PointerEvent): void {
    if (!this.active) return;
    const v = this.video;
    if (!v.videoWidth) return;
    const rect = v.getBoundingClientRect();
    if (this.locked) {
      // travado: só há deslocamento; o ponteiro virtual nunca sai da tela remota
      const r = contentRect(rect.width, rect.height, v.videoWidth, v.videoHeight);
      if (e.type === 'pointermove') {
        const m = moveRelative(this.x, this.y, e.movementX, e.movementY, r.w, r.h);
        this.x = m.x;
        this.y = m.y;
      }
      this.onLocalMove?.(this.x, this.y, true);
      this.pointerButtons(e, this.x, this.y, false);
      return;
    }
    const p = toNormalized(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, v.videoWidth, v.videoHeight);
    if (!p.inside && this.buttons === 0 && e.type !== 'pointerup') {
      this.onLocalMove?.(p.x, p.y, false);
      return;
    }
    this.x = p.x;
    this.y = p.y;
    this.onLocalMove?.(p.x, p.y, true);
    this.pointerButtons(e, p.x, p.y, true);
  }

  private pointerButtons(e: PointerEvent, x: number, y: number, capture: boolean): void {
    if (e.type === 'pointerdown' && isSupportedButton(e.button)) {
      e.preventDefault();
      if (capture) this.video.setPointerCapture(e.pointerId);
      this.buttons |= 1 << e.button;
      this.event({ k: 'md', n: 0, b: e.button, x, y });
    } else if (e.type === 'pointerup' && isSupportedButton(e.button)) {
      if (this.buttons & (1 << e.button)) {
        this.buttons &= ~(1 << e.button);
        this.event({ k: 'mu', n: 0, b: e.button, x, y });
      }
    } else {
      this.send();
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.active) return;
    e.preventDefault();
    const { dx, dy } = wheelUnits(e.deltaX, e.deltaY, e.deltaMode, this.wheelCarry);
    if (dx === 0 && dy === 0) return;
    // o Windows trata rolagem vertical e horizontal em eventos separados
    if (dy !== 0) this.event({ k: 'w', n: 0, x: this.x, y: this.y, dx: 0, dy });
    if (dx !== 0) this.event({ k: 'w', n: 0, x: this.x, y: this.y, dx, dy: 0 });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.active || !e.code) return;
    // digitando no chat ou em outro campo da própria página: não é para o computador remoto
    if (e.target instanceof Element && e.target.closest('[data-no-remote-keys]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (down) {
      this.keys.add(e.code);
      this.event({ k: 'kd', n: 0, c: e.code }); // inclui autorrepetição (e.repeat)
    } else if (this.keys.delete(e.code)) {
      this.event({ k: 'ku', n: 0, c: e.code });
    }
  }

  private event(ev: InputEvent): void {
    ev.n = ++this.eventSeq;
    this.history.push({ at: performance.now(), ev });
    this.send();
    // reenvios curtos: se a última mensagem de uma rajada se perder, o estado chega mesmo assim
    this.resendTimers.forEach(clearTimeout);
    this.resendTimers = [30, 120].map((ms) => window.setTimeout(() => this.send(), ms));
  }

  /** Momento do último envio (para a transferência de arquivos ceder espaço à entrada). */
  lastActivity = 0;

  private send(): void {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return;
    const now = performance.now();
    this.lastActivity = now;
    this.history = this.history.filter((h) => now - h.at <= HISTORY_MS).slice(-HISTORY_MAX);
    const msg: InputMessage = {
      t: 'in',
      s: ++this.seq,
      x: round(this.x),
      y: round(this.y),
      b: this.buttons,
      k: [...this.keys],
      e: this.history.map((h) => h.ev),
    };
    ch.send(JSON.stringify(msg));
  }
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
