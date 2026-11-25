import {
  CONTROL_CHANNEL,
  CHAT_CHANNEL,
  CURSOR_CHANNEL,
  FILE_CHANNEL,
  HOST_ID_PATTERN,
  INPUT_CHANNEL,
  PROTOCOL_VERSION,
  encode,
  normalizeHostId,
  parseControlMessage,
  parseCursorMessage,
  type CursorPosMessage,
  type CursorShapeControlMessage,
  type AuthDeniedReason,
  type AuthResultControlMessage,
  type IceConfig,
  type MonitorsControlMessage,
  type PeerLeftReason,
} from '@remoto/protocol';
import { el } from './dom.ts';
import { InputSender } from './input.ts';
import { contentRect } from './input-map.ts';
import { SidePanel } from './panel.ts';
import { measure, startClock } from './latency.ts';
import { RemoteCandidateQueue, StatsSampler, createPeerConnection, formatStats, toIceCandidate } from './rtc-common.ts';
import { SignalingClient } from './signaling-client.ts';

const form = el<HTMLFormElement>('connect-form');
const input = el<HTMLInputElement>('host-id');
const connectBtn = el<HTMLButtonElement>('connect');
const panel = el('connect-panel');
const remote = el('remote');
const video = el<HTMLVideoElement>('screen');
const statsEl = el('stats');
const statusEl = el('status');
const messageEl = el('message');
const disconnectBtn = el<HTMLButtonElement>('disconnect');
const fullscreenBtn = el<HTMLButtonElement>('fullscreen');

let sig: SignalingClient | null = null;
let ice: IceConfig | null = null;
let pc: RTCPeerConnection | null = null;
let candidates: RemoteCandidateQueue | null = null;
let statsTimer: number | undefined;
let control: RTCDataChannel | null = null;
let streamInfo = '';

const params = new URLSearchParams(location.search);
const MEASURE = params.get('medir') === '1';

/**
 * Ponteiro remoto desenhado sobre o vídeo (não passa pelo encoder). Enquanto o usuário mexe o mouse,
 * a imagem segue o mouse local na hora (sem esperar a rede); parado, segue a posição remota
 * (programas que movem o ponteiro sozinhos).
 */
const remoteCursor = (() => {
  const img = el<HTMLImageElement>('remote-cursor');
  const shapes = new Map<number, { url: string; w: number; h: number; hx: number; hy: number }>();
  let src = { w: 0, h: 0 };
  let last: CursorPosMessage | null = null;
  let local: { x: number; y: number; inside: boolean; at: number } | null = null;
  const LOCAL_WINS_MS = 300;

  const place = () => {
    const m = last;
    const shape = m ? shapes.get(m.id) : undefined;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!m || !shape || !vw || !vh || !src.w) {
      img.hidden = true;
      return;
    }
    const r = contentRect(video.clientWidth, video.clientHeight, vw, vh);
    const scale = r.w / src.w;
    let x = m.x;
    let y = m.y;
    let visible = m.v;
    if (local && performance.now() - local.at < LOCAL_WINS_MS) {
      // o ponto ativo (hotspot) fica exatamente sob o mouse local
      x = local.x - shape.hx / src.w;
      y = local.y - shape.hy / src.h;
      visible = local.inside;
    }
    if (img.src !== shape.url) img.src = shape.url;
    img.style.width = `${shape.w * scale}px`;
    img.style.height = `${shape.h * scale}px`;
    img.style.transform = `translate(${video.offsetLeft + r.x + x * r.w}px, ${video.offsetTop + r.y + y * r.h}px)`;
    img.hidden = !visible;
  };
  window.addEventListener('resize', place);
  return {
    addShape(m: CursorShapeControlMessage) {
      shapes.set(m.id, { url: `data:image/png;base64,${m.png}`, w: m.w, h: m.h, hx: m.hx, hy: m.hy });
      place();
    },
    setSource(w: number, h: number) {
      src = { w, h };
      place();
    },
    move(m: CursorPosMessage) {
      last = m;
      place();
    },
    local(x: number, y: number, inside: boolean) {
      local = { x, y, inside, at: performance.now() };
      place();
    },
    hide() {
      last = null;
      local = null;
      img.hidden = true;
    },
  };
})();

const inputSender = new InputSender(video);
inputSender.onLocalMove = (x, y, inside) => remoteCursor.local(x, y, inside);

// Arquivo cede a vez ao mouse/teclado: com entrada recente, a fila de envio fica pequena (64 KB).
const panel2 = new SidePanel(() => (performance.now() - inputSender.lastActivity < 500 ? 64 * 1024 : 1024 * 1024));
remote.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  remote.classList.add('dragging');
});
remote.addEventListener('dragleave', () => remote.classList.remove('dragging'));
remote.addEventListener('drop', (e) => {
  e.preventDefault();
  remote.classList.remove('dragging');
  panel2.sendFiles([...(e.dataTransfer?.files ?? [])]);
});

// O agente (modo túnel) entrega o próprio instalador em /baixar; o servidor Node redireciona se tiver
// DOWNLOAD_URL. Sem nenhum dos dois, o link fica oculto.
void fetch('/baixar', { method: 'HEAD', redirect: 'manual' })
  .then((r) => {
    if (r.ok || r.type === 'opaqueredirect') el<HTMLElement>('download').hidden = false;
  })
  .catch(() => {});

const controlBtn = el<HTMLButtonElement>('control-toggle');
const lockBtn = el<HTMLButtonElement>('pointer-lock');
const cadBtn = el<HTMLButtonElement>('cad');
// Ctrl+Alt+Del não chega à página (o Windows local o captura): vai como comando ao agente.
cadBtn.addEventListener('click', () => {
  if (control?.readyState === 'open') control.send(encode({ t: 'sas' }));
});
const monitorSelect = el<HTMLSelectElement>('monitor');

// Mouse travado (Pointer Lock): o ponteiro fica preso na tela remota até apertar Esc
// (em tela cheia, com o teclado travado, segure Esc).
lockBtn.addEventListener('click', () => {
  if (inputSender.locked) inputSender.unlock();
  else void inputSender.lock();
});
inputSender.onLockChange = (locked) => {
  lockBtn.setAttribute('aria-pressed', String(locked));
  lockBtn.textContent = locked ? 'Soltar mouse (Esc)' : 'Travar mouse';
  remote.classList.toggle('locked', locked);
};

function setControl(on: boolean): void {
  if (!on) {
    inputSender.unlock();
    inputSender.releaseAll();
  }
  lockBtn.disabled = !on;
  cadBtn.disabled = !on;
  inputSender.enabled = on;
  controlBtn.setAttribute('aria-pressed', String(on));
  controlBtn.textContent = on ? 'Controle: ligado' : 'Controle: desligado';
  remote.classList.toggle('controlling', on);
}
controlBtn.addEventListener('click', () => setControl(!inputSender.enabled));
monitorSelect.addEventListener('change', () => {
  if (control?.readyState === 'open') control.send(encode({ t: 'select-monitor', index: Number(monitorSelect.value) }));
});

function showMonitors(m: MonitorsControlMessage): void {
  monitorSelect.replaceChildren(
    ...m.list.map((d) => {
      const o = document.createElement('option');
      o.value = String(d.index);
      o.textContent = `Monitor ${d.index + 1} · ${d.width}×${d.height}${d.primary ? ' (principal)' : ''}`;
      return o;
    }),
  );
  monitorSelect.value = String(m.current);
  monitorSelect.hidden = m.list.length < 2;
}

function startMeasure(conn: RTCPeerConnection): void {
  setMessage('');
  const out = el('measure-result');
  void measure(video, conn, {
    warmupMs: 4000,
    durationMs: 20000,
    onProgress: (t) => (out.textContent = t),
  }).then((report) => {
    const text = `Latência ponta a ponta: mediana ${report.medianMs} ms · p95 ${report.p95Ms} ms · mín ${report.minMs} · máx ${report.maxMs} (${report.samples} amostras) · jitter buffer ${report.jitterBufferMs} ms · decodificação ${report.decodeMs} ms · ${report.fps} fps`;
    out.textContent = text;
    document.title = `Medido: mediana ${report.medianMs} ms`;
    (window as unknown as { __remotoLatency: unknown }).__remotoLatency = report;
    if (control?.readyState === 'open') control.send(encode(report));
  });
}

if (MEASURE) {
  document.body.classList.add('measure');
  startClock(el<HTMLCanvasElement>('clock'));
  // só preenche o ID: a senha é digitada (nunca vai na URL)
  const id = params.get('id');
  if (id) input.value = id;
}

const setStatus = (t: string) => (statusEl.textContent = t);
const setMessage = (t: string) => (messageEl.textContent = t);

const PEER_LEFT_TEXT: Record<PeerLeftReason, string> = {
  refused: 'O computador remoto recusou a conexão.',
  ended: 'O computador remoto encerrou a sessão.',
  disconnected: 'O computador remoto ficou offline.',
  replaced: 'O computador remoto reconectou. Conecte novamente.',
};

const passwordInput = el<HTMLInputElement>('password');
/** Conectado, aguardando senha (ou nova tentativa depois de errar). */
let awaitingAuth = false;

const DENIED_TEXT: Record<AuthDeniedReason, (m: AuthResultControlMessage) => string> = {
  'wrong-password': (m) => `Senha incorreta. Tentativas restantes nesta conexão: ${m.attemptsLeft ?? 0}.`,
  'too-many-attempts': () => 'Senha incorreta muitas vezes. Conexão encerrada.',
  locked: (m) => `Muitas tentativas erradas neste computador. Tente de novo em ${m.retryAfterS ?? 30} s.`,
  refused: () => 'O usuário do computador remoto recusou o acesso.',
  timeout: () => 'Tempo esgotado sem autorização.',
};

let authRetry: number | undefined;

function stopAuthRetry(): void {
  clearTimeout(authRetry);
  authRetry = undefined;
}

function sendAuth(attempt = 1): void {
  if (control?.readyState !== 'open') return;
  awaitingAuth = false;
  connectBtn.disabled = true;
  setStatus('Verificando a senha…');
  control.send(encode({ t: 'auth', password: passwordInput.value }));
  // Sem resposta (mensagem perdida na abertura do canal): reenvia. O host ignora duplicatas.
  stopAuthRetry();
  if (attempt < 3) authRetry = window.setTimeout(() => sendAuth(attempt + 1), 4000);
}

function onAuthResult(m: AuthResultControlMessage): void {
  stopAuthRetry();
  if (m.ok) {
    passwordInput.value = '';
    setMessage('');
    setStatus('Conectado');
    showRemote(true);
    return;
  }
  const text = m.reason ? DENIED_TEXT[m.reason](m) : 'Acesso negado.';
  if (m.reason === 'wrong-password') {
    // a conexão continua: pode tentar de novo sem reconectar
    awaitingAuth = true;
    connectBtn.disabled = false;
    passwordInput.select();
    setStatus('Aguardando a senha');
    setMessage(text);
    return;
  }
  teardown();
  setMessage(text);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (awaitingAuth && control?.readyState === 'open') sendAuth(1);
  else void connect();
});
disconnectBtn.addEventListener('click', () => hangUp());
// Em tela cheia, a Keyboard Lock API deixa passar Alt+Tab, Win, Ctrl+W etc. para o computador remoto
// (segurar Esc sai da tela cheia).
// Em tela cheia o mouse também fica travado na tela remota.
fullscreenBtn.addEventListener('click', () => {
  void remote
    .requestFullscreen?.()
    .then(() => (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.())
    .then(() => inputSender.enabled && inputSender.lock());
});

async function connect(): Promise<void> {
  const id = normalizeHostId(input.value);
  if (!HOST_ID_PATTERN.test(id)) {
    setMessage('Digite um ID de 9 dígitos.');
    return;
  }
  teardown();
  setMessage('');
  connectBtn.disabled = true;
  setStatus('Conectando ao servidor…');

  let s: SignalingClient;
  try {
    s = await SignalingClient.connect();
  } catch (err) {
    connectBtn.disabled = false;
    setStatus('Desconectado');
    setMessage((err as Error).message);
    return;
  }
  sig = s;

  s.on('joined', (m) => {
    ice = m.ice;
    setStatus('Aguardando o computador remoto aceitar…');
    disconnectBtn.hidden = false;
  });
  s.on('offer', (m) => {
    handleOffer(s, m.sdp).catch((err: Error) => {
      setMessage(`Falha na negociação: ${err.message}`);
      hangUp();
    });
  });
  s.on('ice', (m) => void candidates?.add(m.candidate));
  s.on('peer-left', (m) => {
    teardown();
    setMessage(PEER_LEFT_TEXT[m.reason]);
  });
  s.on('error', (m) => {
    if (m.code === 'not-paired') return; // corrida inofensiva após encerrar
    teardown();
    setMessage(m.message);
  });
  s.onClose(() => {
    if (sig !== s) return;
    teardown();
    setMessage('Conexão com o servidor perdida.');
  });

  s.send({ type: 'join', v: PROTOCOL_VERSION, id });
}

async function handleOffer(s: SignalingClient, sdp: string): Promise<void> {
  if (!ice) throw new Error('configuração ICE ausente');
  const conn = pc ?? createPc(s, ice);
  await conn.setRemoteDescription({ type: 'offer', sdp });
  await candidates?.flush();
  const answer = await conn.createAnswer();
  await conn.setLocalDescription(answer);
  s.send({ type: 'answer', sdp: conn.localDescription?.sdp ?? answer.sdp ?? '' });
}

function createPc(s: SignalingClient, iceConfig: IceConfig): RTCPeerConnection {
  const conn = createPeerConnection(iceConfig);
  pc = conn;
  candidates = new RemoteCandidateQueue(conn);

  conn.addEventListener('track', (e) => {
    // Menor atraso de exibição possível (Chrome: jitterBufferTarget; legado: playoutDelayHint).
    const r = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
    try {
      if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
      r.playoutDelayHint = 0;
    } catch {
      /* não suportado */
    }
    // o vídeo só aparece depois da senha + aceite (auth-result ok); antes disso nada é capturado
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    if (MEASURE) startMeasure(conn);
  });

  conn.addEventListener('datachannel', (e) => {
    const ch = e.channel;
    if (ch.label === INPUT_CHANNEL) {
      inputSender.attach(ch);
      return;
    }
    if (ch.label === CHAT_CHANNEL) {
      panel2.attachChat(ch);
      return;
    }
    if (ch.label === FILE_CHANNEL) {
      panel2.attachFile(ch);
      return;
    }
    if (ch.label === CURSOR_CHANNEL) {
      ch.addEventListener('message', (ev) => {
        const p = parseCursorMessage(ev.data);
        if (p.ok) remoteCursor.move(p.msg);
      });
      return;
    }
    if (ch.label !== CONTROL_CHANNEL) return;
    control = ch;
    const hello = () => {
      ch.send(encode({ t: 'hello', role: 'viewer', agent: 'web-client' }));
      sendAuth(1);
    };
    if (ch.readyState === 'open') hello();
    else ch.addEventListener('open', hello, { once: true });
    ch.addEventListener('message', (ev) => {
      const p = parseControlMessage(ev.data);
      if (!p.ok) return;
      const m = p.msg;
      if (m.t === 'hello') console.info(`Canal de controle aberto (${m.agent}).`);
      else if (m.t === 'stream-info') {
        streamInfo = `${m.encoder.split(' (')[0]} · ${m.width}×${m.height}@${m.fps}`;
        remoteCursor.setSource(m.sourceWidth, m.sourceHeight);
      } else if (m.t === 'cursor-shape') remoteCursor.addShape(m);
      else if (m.t === 'monitors') showMonitors(m);
      else if (m.t === 'auth-status') {
        stopAuthRetry();
        setStatus('Senha correta. Aguardando o usuário do computador remoto aceitar…');
      }
      else if (m.t === 'auth-result') onAuthResult(m);
    });
  });

  conn.addEventListener('icecandidate', (e) => {
    s.send({ type: 'ice', candidate: e.candidate ? toIceCandidate(e.candidate) : null });
  });

  conn.addEventListener('connectionstatechange', () => {
    if (pc !== conn) return;
    switch (conn.connectionState) {
      case 'connected':
        setStatus('Conectado');
        startStats(conn);
        break;
      case 'disconnected':
        setStatus('Reconectando…');
        break;
      case 'failed':
        setMessage('Falha na conexão P2P. Verifique STUN/TURN.');
        hangUp();
        break;
    }
  });
  return conn;
}

function startStats(conn: RTCPeerConnection): void {
  stopStats();
  const sampler = new StatsSampler(conn);
  statsTimer = window.setInterval(async () => {
    if (pc !== conn) return;
    const text = formatStats(await sampler.sample());
    statsEl.textContent = streamInfo ? `${streamInfo} · ${text}` : text;
  }, 1000);
}

function stopStats(): void {
  if (statsTimer !== undefined) clearInterval(statsTimer);
  statsTimer = undefined;
  statsEl.textContent = '';
}

function showRemote(on: boolean): void {
  remote.hidden = !on;
  panel.hidden = on;
  fullscreenBtn.hidden = !on;
  controlBtn.hidden = !on || MEASURE;
  lockBtn.hidden = !on || MEASURE;
  cadBtn.hidden = !on || MEASURE;
  if (!on) inputSender.unlock();
  panel2.setVisible(on && !MEASURE);
  if (on) setControl(!MEASURE);
}

function hangUp(): void {
  sig?.send({ type: 'bye', reason: 'ended' });
  teardown();
}

function teardown(): void {
  stopStats();
  pc?.close();
  pc = null;
  candidates = null;
  ice = null;
  control = null;
  awaitingAuth = false;
  stopAuthRetry();
  streamInfo = '';
  remoteCursor.hide();
  inputSender.detach();
  panel2.detach();
  monitorSelect.hidden = true;
  video.srcObject = null;
  showRemote(false);
  const s = sig;
  sig = null;
  s?.close();
  connectBtn.disabled = false;
  disconnectBtn.hidden = true;
  setStatus('Desconectado');
}
