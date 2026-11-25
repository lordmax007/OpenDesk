import type { IceCandidate, IceConfig } from '@remoto/protocol';

export function createPeerConnection(ice: IceConfig): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: ice.iceServers,
    iceTransportPolicy: ice.iceTransportPolicy,
  });
}

export function toIceCandidate(c: RTCIceCandidate): IceCandidate {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment,
  };
}

/** Guarda candidatos remotos até a descrição remota ser aplicada. */
export class RemoteCandidateQueue {
  private pending: RTCIceCandidateInit[] = [];

  constructor(private readonly pc: RTCPeerConnection) {}

  async add(c: IceCandidate | null): Promise<void> {
    if (!c) return; // fim dos candidatos: opcional no Chrome
    const init: RTCIceCandidateInit = {
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? null,
      usernameFragment: c.usernameFragment ?? null,
    };
    if (!this.pc.remoteDescription) {
      this.pending.push(init);
      return;
    }
    await this.apply(init);
  }

  async flush(): Promise<void> {
    const list = this.pending;
    this.pending = [];
    for (const c of list) await this.apply(c);
  }

  private async apply(c: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(c);
    } catch (err) {
      console.warn('Candidato ICE rejeitado:', err);
    }
  }
}

export interface StatsSnapshot {
  width?: number;
  height?: number;
  fps?: number;
  kbps?: number;
  route?: 'direta' | 'TURN (relay)';
  rttMs?: number;
}

/** Amostra estatísticas de vídeo recebido e da rota ICE escolhida. */
export class StatsSampler {
  private lastBytes = 0;
  private lastTs = 0;

  constructor(private readonly pc: RTCPeerConnection) {}

  async sample(): Promise<StatsSnapshot> {
    const report = await this.pc.getStats();
    const out: StatsSnapshot = {};
    let pairId: string | undefined;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.width = s.frameWidth;
        out.height = s.frameHeight;
        out.fps = s.framesPerSecond;
        if (this.lastTs && s.timestamp > this.lastTs) {
          out.kbps = Math.round(((s.bytesReceived - this.lastBytes) * 8) / (s.timestamp - this.lastTs));
        }
        this.lastBytes = s.bytesReceived;
        this.lastTs = s.timestamp;
      } else if (s.type === 'transport' && s.selectedCandidatePairId) {
        pairId = s.selectedCandidatePairId;
      }
    });
    const pair = pairId ? report.get(pairId) : undefined;
    if (pair) {
      if (typeof pair.currentRoundTripTime === 'number') out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      out.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN (relay)' : 'direta';
    }
    return out;
  }
}

export function formatStats(s: StatsSnapshot): string {
  const parts: string[] = [];
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.fps !== undefined) parts.push(`${Math.round(s.fps)} fps`);
  if (s.kbps !== undefined) parts.push(`${s.kbps} kbit/s`);
  if (s.route) parts.push(`rota ${s.route}`);
  if (s.rttMs !== undefined) parts.push(`RTT ${s.rttMs} ms`);
  return parts.join(' · ');
}
