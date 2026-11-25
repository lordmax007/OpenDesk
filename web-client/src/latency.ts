/**
 * Medição de latência ponta a ponta (?medir=1).
 * A página desenha o relógio (ms, 32 bits + checksum) como código de barras na faixa superior da tela.
 * O agente captura a tela, codifica e envia; aqui o vídeo é decodificado e o código lido em cada quadro
 * (requestVideoFrameCallback). Latência = hora prevista de exibição do quadro − hora gravada no código.
 * Mesmo documento, mesmo relógio: não há sincronização entre máquinas envolvida.
 */
import type { LatencyReportControlMessage } from '@remoto/protocol';

const COLS = 20;
const ROWS = 2;
export const BAND_FRACTION = 0.2;

function checksum(v: number): number {
  return (((v & 0xff) + ((v >>> 8) & 0xff) + ((v >>> 16) & 0xff) + ((v >>> 24) & 0xff)) & 0xff) ^ 0x5a;
}

export function encodeBits(ms: number): boolean[] {
  const v = ms >>> 0;
  const c = checksum(v);
  const bits: boolean[] = [];
  for (let i = 31; i >= 0; i--) bits.push(((v >>> i) & 1) === 1);
  for (let i = 7; i >= 0; i--) bits.push(((c >>> i) & 1) === 1);
  return bits;
}

export function decodeBits(bits: boolean[]): number | null {
  if (bits.length !== 40) return null;
  let v = 0;
  for (let i = 0; i < 32; i++) v = ((v << 1) | (bits[i] ? 1 : 0)) >>> 0;
  let c = 0;
  for (let i = 32; i < 40; i++) c = (c << 1) | (bits[i] ? 1 : 0);
  return c === checksum(v) ? v : null;
}

const nowEpoch = (t: number) => performance.timeOrigin + t;

/** Desenha o código de barras continuamente num canvas que ocupa a faixa superior. */
export function startClock(canvas: HTMLCanvasElement): void {
  const g = canvas.getContext('2d')!;
  const draw = (t: number) => {
    canvas.width = COLS;
    canvas.height = ROWS;
    const bits = encodeBits(Math.round(nowEpoch(t)));
    bits.forEach((b, i) => {
      g.fillStyle = b ? '#fff' : '#000';
      g.fillRect(i % COLS, Math.floor(i / COLS), 1, 1);
    });
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

export interface MeasureOptions {
  warmupMs: number;
  durationMs: number;
  onProgress: (text: string) => void;
}

/** Lê o código de cada quadro decodificado e devolve as estatísticas. */
export function measure(video: HTMLVideoElement, pc: RTCPeerConnection, opts: MeasureOptions): Promise<LatencyReportControlMessage> {
  const sample = document.createElement('canvas');
  sample.width = COLS * 4;
  sample.height = ROWS * 4;
  const g = sample.getContext('2d', { willReadFrequently: true })!;
  const values: number[] = [];
  let failures = 0;
  const start = performance.now();

  return new Promise((resolve) => {
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      const elapsed = performance.now() - start;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        g.drawImage(video, 0, 0, vw, vh * BAND_FRACTION, 0, 0, sample.width, sample.height);
        const px = g.getImageData(0, 0, sample.width, sample.height).data;
        const bits: boolean[] = [];
        for (let i = 0; i < COLS * ROWS; i++) {
          const x = (i % COLS) * 4 + 2;
          const y = Math.floor(i / COLS) * 4 + 2;
          const o = (y * sample.width + x) * 4;
          bits.push(0.299 * px[o]! + 0.587 * px[o + 1]! + 0.114 * px[o + 2]! > 128);
        }
        const stamped = decodeBits(bits);
        if (stamped === null) failures++;
        else if (elapsed > opts.warmupMs) {
          const shown = Math.round(nowEpoch(meta.expectedDisplayTime)) >>> 0;
          const latency = (shown - stamped) >>> 0;
          if (latency < 10_000) values.push(latency);
        }
      }
      if (elapsed < opts.warmupMs + opts.durationMs) {
        if (values.length % 30 === 0) opts.onProgress(`medindo… ${values.length} amostras, ${failures} quadros ilegíveis`);
        video.requestVideoFrameCallback(onFrame);
      } else {
        void finish();
      }
    };

    const finish = async () => {
      const sorted = [...values].sort((a, b) => a - b);
      const pct = (p: number) => (sorted.length ? sorted[Math.round((sorted.length - 1) * p)]! : 0);
      let jitterBufferMs = 0;
      let decodeMs = 0;
      let fps = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          if (s.jitterBufferEmittedCount) jitterBufferMs = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
          if (s.framesDecoded) decodeMs = (s.totalDecodeTime / s.framesDecoded) * 1000;
          fps = s.framesPerSecond ?? 0;
        }
      });
      resolve({
        t: 'latency-report',
        samples: sorted.length,
        medianMs: pct(0.5),
        p95Ms: pct(0.95),
        minMs: sorted[0] ?? 0,
        maxMs: sorted[sorted.length - 1] ?? 0,
        jitterBufferMs: Math.round(jitterBufferMs * 10) / 10,
        decodeMs: Math.round(decodeMs * 10) / 10,
        fps,
      });
    };

    video.requestVideoFrameCallback(onFrame);
  });
}
