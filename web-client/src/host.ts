/**
 * Host de protótipo (Etapa 1): compartilha a tela pelo Chrome com getDisplayMedia.
 * Na Etapa 2 o agente nativo do Windows assume este papel com o mesmo protocolo.
 */
import {
  CONTROL_CHANNEL,
  PROTOCOL_VERSION,
  encode,
  formatHostId,
  parseControlMessage,
  type IceConfig,
  type PeerLeftReason,
} from '@remoto/protocol';
import { el } from './dom.ts';
import { RemoteCandidateQueue, createPeerConnection, toIceCandidate } from './rtc-common.ts';
import { SignalingClient } from './signaling-client.ts';

const startBtn = el<HTMLButtonElement>('start');
const stopBtn = el<HTMLButtonElement>('stop');
const idBox = el('host-id');
const statusEl = el('status');
const messageEl = el('message');
const preview = el<HTMLVideoElement>('preview');
const requestPanel = el('request');
const acceptBtn = el<HTMLButtonElement>('accept');
const refuseBtn = el<HTMLButtonElement>('refuse');
const banner = el('session-banner');
const endBtn = el<HTMLButtonElement>('end-session');

const REQUEST_TIMEOUT_MS = 60_000;
const IDENTITY_KEY = 'remoto.host.identity';

let stream: MediaStream | null = null;
let sig: SignalingClient | null = null;
let ice: IceConfig | null = null;
let pc: RTCPeerConnection | null = null;
let candidates: RemoteCandidateQueue | null = null;
let requestTimer: number | undefined;
let usedSavedIdentity = false;

const setStatus = (t: string) => (statusEl.textContent = t);
const setMessage = (t: string) => (messageEl.textContent = t);

const PEER_LEFT_TEXT: Record<PeerLeftReason, string> = {
  ended: 'O visualizador encerrou a sessão.',
  refused: 'Conexão recusada.',
  disconnected: 'O visualizador desconectou.',
  replaced: 'Sessão substituída.',
};

// ID estável entre recarregamentos (protótipo: guarda id + token no localStorage).
function loadIdentity(): { id: string; token: string } | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as { id: string; token: string }) : null;
  } catch {
    return null;
  }
}
function saveIdentity(id: string, token: string): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ id, token }));
  } catch {
    /* sem armazenamento: o ID muda a cada vez */
  }
}
function clearIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* ignorado */
  }
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', () => stop());
acceptBtn.addEventListener('click', () => accept());
refuseBtn.addEventListener('click', () => refuse());
endBtn.addEventListener('click', () => {
  sig?.send({ type: 'bye', reason: 'ended' });
  endSession();
  setStatus('Aguardando conexão');
});

async function start(): Promise<void> {
  setMessage('');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setMessage('Captura de tela indisponível aqui. Abra esta página por http://localhost:<porta>/host.html ou via HTTPS.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
  } catch {
    setMessage('Compartilhamento de tela cancelado.');
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.contentHint = 'detail';
    track.addEventListener('ended', () => stop('Compartilhamento encerrado pelo navegador.'));
  }
  preview.srcObject = stream;
  startBtn.hidden = true;
  stopBtn.hidden = false;
  setStatus('Conectando ao servidor…');

  let s: SignalingClient;
  try {
    s = await SignalingClient.connect();
  } catch (err) {
    stop((err as Error).message);
    return;
  }
  sig = s;
  wire(s);
  register(s, true);
}

function register(s: SignalingClient, useSaved: boolean): void {
  const saved = useSaved ? loadIdentity() : null;
  usedSavedIdentity = saved !== null;
  s.send(
    saved
      ? { type: 'register', v: PROTOCOL_VERSION, id: saved.id, token: saved.token }
      : { type: 'register', v: PROTOCOL_VERSION },
  );
}

function wire(s: SignalingClient): void {
  s.on('registered', (m) => {
    ice = m.ice;
    saveIdentity(m.id, m.token);
    idBox.textContent = formatHostId(m.id);
    setStatus('Aguardando conexão');
  });
  s.on('peer-joined', () => showRequest());
  s.on('answer', (m) => {
    const conn = pc;
    if (!conn) return;
    conn
      .setRemoteDescription({ type: 'answer', sdp: m.sdp })
      .then(() => candidates?.flush())
      .catch((err: Error) => failSession(`Falha na negociação: ${err.message}`));
  });
  s.on('ice', (m) => void candidates?.add(m.candidate));
  s.on('peer-left', (m) => {
    hideRequest();
    endSession();
    setStatus('Aguardando conexão');
    setMessage(PEER_LEFT_TEXT[m.reason]);
  });
  s.on('error', (m) => {
    if (m.code === 'id-unavailable' && usedSavedIdentity) {
      clearIdentity();
      register(s, false);
      return;
    }
    if (m.code === 'not-paired') return; // corrida inofensiva após encerrar
    setMessage(`Servidor: ${m.message}`);
  });
  s.onClose(() => {
    if (sig !== s) return;
    stop('Conexão com o servidor perdida.');
  });
}

function showRequest(): void {
  requestPanel.hidden = false;
  document.title = 'Pedido de conexão · Remoto';
  setStatus('Pedido de conexão');
  requestTimer = window.setTimeout(() => refuse(), REQUEST_TIMEOUT_MS);
}

function hideRequest(): void {
  requestPanel.hidden = true;
  if (requestTimer !== undefined) clearTimeout(requestTimer);
  requestTimer = undefined;
  if (!pc) document.title = 'Remoto · Host';
}

function refuse(): void {
  hideRequest();
  sig?.send({ type: 'bye', reason: 'refused' });
  setStatus('Aguardando conexão');
}

function accept(): void {
  hideRequest();
  startSession().catch((err: Error) => failSession(`Falha ao iniciar a sessão: ${err.message}`));
}

async function startSession(): Promise<void> {
  const s = sig;
  if (!s || !stream || !ice) return;
  endSession();

  const conn = createPeerConnection(ice);
  pc = conn;
  candidates = new RemoteCandidateQueue(conn);
  for (const track of stream.getTracks()) conn.addTrack(track, stream);

  const control = conn.createDataChannel(CONTROL_CHANNEL, { ordered: true });
  control.addEventListener('open', () => control.send(encode({ t: 'hello', role: 'host', agent: 'host.html' })));
  control.addEventListener('message', (ev) => {
    const p = parseControlMessage(ev.data);
    if (p.ok && p.msg.t === 'hello') console.info(`Canal de controle aberto (${p.msg.agent}).`);
    // Protótipo: sem senha; o aceite local já aconteceu antes da oferta.
    if (p.ok && p.msg.t === 'auth') control.send(encode({ t: 'auth-result', ok: true }));
  });

  conn.addEventListener('icecandidate', (e) => {
    s.send({ type: 'ice', candidate: e.candidate ? toIceCandidate(e.candidate) : null });
  });
  conn.addEventListener('connectionstatechange', () => {
    if (pc !== conn) return;
    if (conn.connectionState === 'connected') setStatus('Sessão ativa');
    else if (conn.connectionState === 'failed') failSession('Não foi possível conectar. Verifique STUN/TURN.');
  });

  showBanner(true);
  setStatus('Conectando…');
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  s.send({ type: 'offer', sdp: conn.localDescription?.sdp ?? offer.sdp ?? '' });
}

function failSession(message: string): void {
  setMessage(message);
  sig?.send({ type: 'bye', reason: 'ended' });
  endSession();
  setStatus('Aguardando conexão');
}

function endSession(): void {
  pc?.close();
  pc = null;
  candidates = null;
  showBanner(false);
}

function showBanner(on: boolean): void {
  banner.hidden = !on;
  document.body.classList.toggle('in-session', on);
  document.title = on ? '● Sessão ativa · Remoto' : 'Remoto · Host';
}

function stop(message?: string): void {
  hideRequest();
  if (pc) sig?.send({ type: 'bye', reason: 'ended' });
  endSession();
  const s = sig;
  sig = null;
  s?.close();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  preview.srcObject = null;
  ice = null;
  idBox.textContent = '— — —';
  startBtn.hidden = false;
  stopBtn.hidden = true;
  setStatus('Inativo');
  if (message) setMessage(message);
}
