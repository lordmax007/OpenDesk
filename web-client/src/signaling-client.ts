import { encode, parseServerMessage, type ClientMessage, type ServerMessage } from '@remoto/protocol';

type ByType = { [K in ServerMessage['type']]: Extract<ServerMessage, { type: K }> };
type Handler<T> = (msg: T) => void;

declare global {
  interface Window {
    REMOTO_CONFIG?: { signalingUrl?: string | null };
  }
}

/** URL do WebSocket: config.js ou, por padrão, o mesmo endereço da página em /ws. */
export function defaultSignalingUrl(): string {
  const configured = window.REMOTO_CONFIG?.signalingUrl;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Cliente tipado do servidor de sinalização. */
export class SignalingClient {
  private readonly handlers = new Map<string, Set<Handler<never>>>();
  private readonly closeHandlers = new Set<(info: { code: number; reason: string }) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const parsed = parseServerMessage(ev.data);
      if (!parsed.ok) {
        console.warn('Mensagem inválida do servidor:', parsed.error);
        return;
      }
      const set = this.handlers.get(parsed.msg.type);
      set?.forEach((h) => (h as Handler<ServerMessage>)(parsed.msg));
    });
    ws.addEventListener('close', (ev) => {
      this.closeHandlers.forEach((h) => h({ code: ev.code, reason: ev.reason }));
    });
  }

  static connect(url = defaultSignalingUrl(), timeoutMs = 10_000): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Tempo esgotado ao conectar ao servidor de sinalização.'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new SignalingClient(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Não foi possível conectar ao servidor de sinalização.'));
        },
        { once: true },
      );
    });
  }

  on<K extends keyof ByType>(type: K, handler: Handler<ByType[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  onClose(handler: (info: { code: number; reason: string }) => void): void {
    this.closeHandlers.add(handler);
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  close(): void {
    this.ws.close(1000);
  }
}
