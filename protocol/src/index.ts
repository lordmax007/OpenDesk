/**
 * Protocolo de sinalização do Remoto (v1) — ver docs/arquitetura.md.
 * Fonte única de verdade para tipos e validação, usada pelo servidor e pelo cliente web.
 * Sem dependências: roda no Node e no navegador.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  maxMessageBytes: 64 * 1024,
  maxSdpLength: 60_000,
  maxCandidateLength: 2_048,
  maxMidLength: 64,
  maxUfragLength: 256,
  maxIceServers: 8,
  maxUrlsPerServer: 8,
  maxUrlLength: 512,
  maxCredentialLength: 512,
  maxErrorMessageLength: 500,
  maxAgentNameLength: 100,
  /** Mensagens de controle podem levar a imagem do ponteiro. */
  maxControlMessageBytes: 256 * 1024,
  maxCursorSize: 128,
  maxCursorPngBase64: 200_000,
} as const;

/** ID de host: 9 dígitos, sem zero à esquerda. */
export const HOST_ID_PATTERN = /^[1-9][0-9]{8}$/;
/** Token de reserva do ID: base64url, 32–128 caracteres. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):\S+$/;

export const BYE_REASONS = ['ended', 'refused'] as const;
export type ByeReason = (typeof BYE_REASONS)[number];

export const PEER_LEFT_REASONS = ['ended', 'refused', 'disconnected', 'replaced'] as const;
export type PeerLeftReason = (typeof PEER_LEFT_REASONS)[number];

export const ERROR_CODES = [
  'bad-message',
  'unsupported-version',
  'already-registered',
  'id-unavailable',
  'host-not-found',
  'host-busy',
  'not-paired',
  'forbidden',
  'rate-limited',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------- tipos

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy: 'all' | 'relay';
}

// cliente → servidor
export interface RegisterMessage {
  type: 'register';
  v: typeof PROTOCOL_VERSION;
  id?: string;
  token?: string;
}
export interface JoinMessage {
  type: 'join';
  v: typeof PROTOCOL_VERSION;
  id: string;
}
export interface ByeMessage {
  type: 'bye';
  reason: ByeReason;
}

// repassadas entre as pontas (nos dois sentidos)
export interface OfferMessage {
  type: 'offer';
  sdp: string;
}
export interface AnswerMessage {
  type: 'answer';
  sdp: string;
}
export interface IceMessage {
  type: 'ice';
  candidate: IceCandidate | null;
}
export type RelayMessage = OfferMessage | AnswerMessage | IceMessage;

export type ClientMessage = RegisterMessage | JoinMessage | ByeMessage | RelayMessage;

// servidor → cliente
export interface RegisteredMessage {
  type: 'registered';
  id: string;
  token: string;
  ice: IceConfig;
}
export interface JoinedMessage {
  type: 'joined';
  id: string;
  ice: IceConfig;
}
export interface PeerJoinedMessage {
  type: 'peer-joined';
}
export interface PeerLeftMessage {
  type: 'peer-left';
  reason: PeerLeftReason;
}
export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | RegisteredMessage
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | ErrorMessage
  | RelayMessage;

// DataChannel "control" (ordenado, confiável)
export const CONTROL_CHANNEL = 'control';
export interface HelloControlMessage {
  t: 'hello';
  role: 'host' | 'viewer';
  agent: string;
}
/** host → visualizador: o que está sendo transmitido (Etapa 2). */
export interface StreamInfoControlMessage {
  t: 'stream-info';
  encoder: string;
  width: number;
  height: number;
  fps: number;
  hardware: boolean;
  sourceWidth: number;
  sourceHeight: number;
}
/** host → visualizador: imagem do ponteiro (PNG em base64). */
export interface CursorShapeControlMessage {
  t: 'cursor-shape';
  id: number;
  w: number;
  h: number;
  hx: number;
  hy: number;
  png: string;
}
/** visualizador → host: resultado do modo de medição de latência. */
export interface LatencyReportControlMessage {
  t: 'latency-report';
  samples: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  jitterBufferMs: number;
  decodeMs: number;
  fps: number;
}
export interface MonitorDesc {
  index: number;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}
/** host → visualizador: monitores disponíveis e o capturado (Etapa 3). */
export interface MonitorsControlMessage {
  t: 'monitors';
  list: MonitorDesc[];
  current: number;
}
/** visualizador → host: trocar o monitor capturado (Etapa 3). */
export interface SelectMonitorControlMessage {
  t: 'select-monitor';
  index: number;
}
/** visualizador → host: senha temporária (Etapa 5). Só pelo DataChannel (DTLS), nunca pela sinalização. */
export interface AuthControlMessage {
  t: 'auth';
  password: string;
}
/** visualizador → host: Ctrl+Alt+Del (só tem efeito com o agente instalado como serviço). */
export interface SasControlMessage {
  t: 'sas';
}
/** host → visualizador: senha aceita, aguardando o usuário local aceitar. */
export interface AuthStatusControlMessage {
  t: 'auth-status';
  status: 'awaiting-consent';
}
export const AUTH_DENIED_REASONS = ['wrong-password', 'too-many-attempts', 'locked', 'refused', 'timeout'] as const;
export type AuthDeniedReason = (typeof AUTH_DENIED_REASONS)[number];
/** host → visualizador: resultado final do acesso. */
export interface AuthResultControlMessage {
  t: 'auth-result';
  ok: boolean;
  reason?: AuthDeniedReason;
  attemptsLeft?: number;
  retryAfterS?: number;
}
export type ControlMessage =
  | HelloControlMessage
  | StreamInfoControlMessage
  | CursorShapeControlMessage
  | LatencyReportControlMessage
  | MonitorsControlMessage
  | SelectMonitorControlMessage
  | AuthControlMessage
  | SasControlMessage
  | AuthStatusControlMessage
  | AuthResultControlMessage;

// DataChannel "input" (não ordenado, sem retransmissão) — Etapa 3
export const INPUT_CHANNEL = 'input';
export type InputEvent =
  | { k: 'kd' | 'ku'; n: number; c: string }
  | { k: 'md' | 'mu'; n: number; b: number; x: number; y: number }
  | { k: 'w'; n: number; x: number; y: number; dx: number; dy: number };
/** Estado completo + eventos do último segundo; ver docs/arquitetura.md §13. */
export interface InputMessage {
  t: 'in';
  s: number;
  x: number;
  y: number;
  b: number;
  k: string[];
  e: InputEvent[];
}

// DataChannel "cursor" (não ordenado, sem retransmissão)
export const CURSOR_CHANNEL = 'cursor';
/** Canto superior esquerdo da imagem do ponteiro, normalizado (0–1) na tela capturada. */
export interface CursorPosMessage {
  t: 'pos';
  x: number;
  y: number;
  v: boolean;
  id: number;
}

// DataChannel "chat" (ordenado, confiável) — Etapa 4
export const CHAT_CHANNEL = 'chat';
export const MAX_CHAT_LENGTH = 4000;
export interface ChatMessage {
  t: 'chat';
  text: string;
  /** ms desde 1970 */
  at: number;
}

// DataChannel "file" (ordenado, confiável): JSON para controle + quadros binários de dados — Etapa 4
export const FILE_CHANNEL = 'file';
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export type FileMessage =
  | { t: 'file-offer'; id: string; n: number; name: string; size: number; sha256: string }
  | { t: 'file-accept'; id: string; offset: number }
  | { t: 'file-reject'; id: string; reason: string }
  | { t: 'file-end'; id: string }
  | { t: 'file-done'; id: string; ok: boolean; reason?: string }
  | { t: 'file-cancel'; id: string };

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; code: ErrorCode; error: string };

// ---------------------------------------------------------------- validação

class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'bad-message',
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;

function guard<T>(fn: () => T): ParseResult<T> {
  try {
    return { ok: true, msg: fn() };
  } catch (err) {
    if (err instanceof ProtocolError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function asObject(x: unknown, what: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    throw new ProtocolError(`${what} deve ser um objeto`);
  }
  return x as Obj;
}

function reqString(o: Obj, key: string, max: number, pattern?: RegExp): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ProtocolError(`campo "${key}" deve ser texto`);
  if (v.length > max) throw new ProtocolError(`campo "${key}" excede ${max} caracteres`);
  if (pattern && !pattern.test(v)) throw new ProtocolError(`campo "${key}" tem formato inválido`);
  return v;
}

function optString(o: Obj, key: string, max: number, pattern?: RegExp): string | undefined {
  return o[key] === undefined ? undefined : reqString(o, key, max, pattern);
}

function nullableString(o: Obj, key: string, max: number): string | null | undefined {
  return o[key] === null ? null : optString(o, key, max);
}

function reqNumber(o: Obj, key: string, min: number, max: number, integer = false): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new ProtocolError(`campo "${key}" inválido`);
  }
  return v;
}

function reqBool(o: Obj, key: string): boolean {
  if (typeof o[key] !== 'boolean') throw new ProtocolError(`campo "${key}" deve ser booleano`);
  return o[key] as boolean;
}

function decode(raw: unknown, typeKey = 'type', maxBytes: number = LIMITS.maxMessageBytes): Obj {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.length > maxBytes) throw new ProtocolError('mensagem grande demais');
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProtocolError('JSON inválido');
    }
  }
  const o = asObject(value, 'mensagem');
  if (typeof o[typeKey] !== 'string') throw new ProtocolError(`campo "${typeKey}" ausente`);
  return o;
}

function checkVersion(o: Obj): void {
  if (o.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `versão de protocolo não suportada (esperado ${PROTOCOL_VERSION})`,
      'unsupported-version',
    );
  }
}

function parseIceCandidate(v: unknown): IceCandidate | null {
  if (v === null) return null;
  if (v === undefined) throw new ProtocolError('campo "candidate" ausente');
  const o = asObject(v, 'candidate');
  const c: IceCandidate = { candidate: reqString(o, 'candidate', LIMITS.maxCandidateLength) };
  const mid = nullableString(o, 'sdpMid', LIMITS.maxMidLength);
  if (mid !== undefined) c.sdpMid = mid;
  const idx = o.sdpMLineIndex;
  if (idx === null) c.sdpMLineIndex = null;
  else if (idx !== undefined) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 1023) {
      throw new ProtocolError('campo "sdpMLineIndex" inválido');
    }
    c.sdpMLineIndex = idx;
  }
  const ufrag = nullableString(o, 'usernameFragment', LIMITS.maxUfragLength);
  if (ufrag !== undefined) c.usernameFragment = ufrag;
  return c;
}

function parseRelay(o: Obj): RelayMessage {
  switch (o.type) {
    case 'offer':
      return { type: 'offer', sdp: reqString(o, 'sdp', LIMITS.maxSdpLength) };
    case 'answer':
      return { type: 'answer', sdp: reqString(o, 'sdp', LIMITS.maxSdpLength) };
    case 'ice':
      return { type: 'ice', candidate: parseIceCandidate(o.candidate) };
    default:
      throw new ProtocolError(`tipo de mensagem desconhecido: ${String(o.type).slice(0, 40)}`);
  }
}

function parseIceConfig(v: unknown): IceConfig {
  const o = asObject(v, 'ice');
  const list = o.iceServers;
  if (!Array.isArray(list) || list.length > LIMITS.maxIceServers) {
    throw new ProtocolError('campo "iceServers" inválido');
  }
  const iceServers = list.map((s): IceServer => {
    const so = asObject(s, 'iceServer');
    const rawUrls = typeof so.urls === 'string' ? [so.urls] : so.urls;
    if (!Array.isArray(rawUrls) || rawUrls.length === 0 || rawUrls.length > LIMITS.maxUrlsPerServer) {
      throw new ProtocolError('campo "urls" inválido');
    }
    const urls = rawUrls.map((u) => {
      if (typeof u !== 'string' || u.length > LIMITS.maxUrlLength || !ICE_URL_PATTERN.test(u)) {
        throw new ProtocolError('URL de servidor ICE inválida');
      }
      return u;
    });
    const server: IceServer = { urls };
    const username = optString(so, 'username', LIMITS.maxCredentialLength);
    const credential = optString(so, 'credential', LIMITS.maxCredentialLength);
    if (username !== undefined) server.username = username;
    if (credential !== undefined) server.credential = credential;
    return server;
  });
  const policy = o.iceTransportPolicy ?? 'all';
  if (policy !== 'all' && policy !== 'relay') throw new ProtocolError('iceTransportPolicy inválido');
  return { iceServers, iceTransportPolicy: policy };
}

/** Valida uma mensagem recebida de um cliente (host ou visualizador). */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return guard((): ClientMessage => {
    const o = decode(raw);
    switch (o.type) {
      case 'register': {
        checkVersion(o);
        const id = optString(o, 'id', 9, HOST_ID_PATTERN);
        const token = optString(o, 'token', 128, TOKEN_PATTERN);
        if ((id === undefined) !== (token === undefined)) {
          throw new ProtocolError('"id" e "token" devem ser enviados juntos');
        }
        return id !== undefined && token !== undefined
          ? { type: 'register', v: PROTOCOL_VERSION, id, token }
          : { type: 'register', v: PROTOCOL_VERSION };
      }
      case 'join':
        checkVersion(o);
        return { type: 'join', v: PROTOCOL_VERSION, id: reqString(o, 'id', 9, HOST_ID_PATTERN) };
      case 'bye': {
        const reason = o.reason ?? 'ended';
        if (!oneOf(BYE_REASONS, reason)) throw new ProtocolError('campo "reason" inválido');
        return { type: 'bye', reason };
      }
      default:
        return parseRelay(o);
    }
  });
}

/** Valida uma mensagem recebida do servidor. */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return guard((): ServerMessage => {
    const o = decode(raw);
    switch (o.type) {
      case 'registered':
        return {
          type: 'registered',
          id: reqString(o, 'id', 9, HOST_ID_PATTERN),
          token: reqString(o, 'token', 128, TOKEN_PATTERN),
          ice: parseIceConfig(o.ice),
        };
      case 'joined':
        return { type: 'joined', id: reqString(o, 'id', 9, HOST_ID_PATTERN), ice: parseIceConfig(o.ice) };
      case 'peer-joined':
        return { type: 'peer-joined' };
      case 'peer-left':
        if (!oneOf(PEER_LEFT_REASONS, o.reason)) throw new ProtocolError('campo "reason" inválido');
        return { type: 'peer-left', reason: o.reason };
      case 'error':
        if (!oneOf(ERROR_CODES, o.code)) throw new ProtocolError('campo "code" inválido');
        return { type: 'error', code: o.code, message: reqString(o, 'message', LIMITS.maxErrorMessageLength) };
      default:
        return parseRelay(o);
    }
  });
}

/** Valida uma mensagem do DataChannel "control". */
export function parseControlMessage(raw: unknown): ParseResult<ControlMessage> {
  return guard((): ControlMessage => {
    const o = decode(raw, 't', LIMITS.maxControlMessageBytes);
    const MAX_PX = 16384;
    switch (o.t) {
      case 'hello':
        if (o.role !== 'host' && o.role !== 'viewer') throw new ProtocolError('campo "role" inválido');
        return { t: 'hello', role: o.role, agent: reqString(o, 'agent', LIMITS.maxAgentNameLength) };
      case 'stream-info':
        return {
          t: 'stream-info',
          encoder: reqString(o, 'encoder', LIMITS.maxAgentNameLength),
          width: reqNumber(o, 'width', 1, MAX_PX, true),
          height: reqNumber(o, 'height', 1, MAX_PX, true),
          fps: reqNumber(o, 'fps', 1, 240, true),
          hardware: reqBool(o, 'hardware'),
          sourceWidth: reqNumber(o, 'sourceWidth', 1, MAX_PX, true),
          sourceHeight: reqNumber(o, 'sourceHeight', 1, MAX_PX, true),
        };
      case 'cursor-shape': {
        const w = reqNumber(o, 'w', 1, LIMITS.maxCursorSize, true);
        const h = reqNumber(o, 'h', 1, LIMITS.maxCursorSize, true);
        return {
          t: 'cursor-shape',
          id: reqNumber(o, 'id', 0, 0xffffffff, true),
          w,
          h,
          hx: reqNumber(o, 'hx', 0, w, true),
          hy: reqNumber(o, 'hy', 0, h, true),
          png: reqString(o, 'png', LIMITS.maxCursorPngBase64, /^[A-Za-z0-9+/]+=*$/),
        };
      }
      case 'latency-report': {
        const ms = (k: string) => reqNumber(o, k, 0, 600_000);
        return {
          t: 'latency-report',
          samples: reqNumber(o, 'samples', 0, 1e7, true),
          medianMs: ms('medianMs'),
          p95Ms: ms('p95Ms'),
          minMs: ms('minMs'),
          maxMs: ms('maxMs'),
          jitterBufferMs: ms('jitterBufferMs'),
          decodeMs: ms('decodeMs'),
          fps: reqNumber(o, 'fps', 0, 1000),
        };
      }
      case 'monitors': {
        if (!Array.isArray(o.list) || o.list.length > 16) throw new ProtocolError('campo "list" inválido');
        const list = o.list.map((m): MonitorDesc => {
          const mo = asObject(m, 'monitor');
          return {
            index: reqNumber(mo, 'index', 0, 63, true),
            name: reqString(mo, 'name', LIMITS.maxAgentNameLength),
            width: reqNumber(mo, 'width', 1, MAX_PX, true),
            height: reqNumber(mo, 'height', 1, MAX_PX, true),
            primary: reqBool(mo, 'primary'),
          };
        });
        return { t: 'monitors', list, current: reqNumber(o, 'current', 0, 63, true) };
      }
      case 'select-monitor':
        return { t: 'select-monitor', index: reqNumber(o, 'index', 0, 63, true) };
      case 'auth':
        return { t: 'auth', password: reqString(o, 'password', 128) };
      case 'sas':
        return { t: 'sas' };
      case 'auth-status':
        if (o.status !== 'awaiting-consent') throw new ProtocolError('campo "status" inválido');
        return { t: 'auth-status', status: 'awaiting-consent' };
      case 'auth-result': {
        const msg: AuthResultControlMessage = { t: 'auth-result', ok: reqBool(o, 'ok') };
        if (o.reason !== undefined) {
          if (!oneOf(AUTH_DENIED_REASONS, o.reason)) throw new ProtocolError('campo "reason" inválido');
          msg.reason = o.reason;
        }
        if (o.attemptsLeft !== undefined) msg.attemptsLeft = reqNumber(o, 'attemptsLeft', 0, 100, true);
        if (o.retryAfterS !== undefined) msg.retryAfterS = reqNumber(o, 'retryAfterS', 0, 86_400, true);
        return msg;
      }
      default:
        throw new ProtocolError(`mensagem de controle desconhecida: ${String(o.t).slice(0, 40)}`);
    }
  });
}

/** Valida uma mensagem do DataChannel "chat". */
export function parseChatMessage(raw: unknown): ParseResult<ChatMessage> {
  return guard((): ChatMessage => {
    const o = decode(raw, 't', 32 * 1024);
    if (o.t !== 'chat') throw new ProtocolError('mensagem de chat desconhecida');
    return { t: 'chat', text: reqString(o, 'text', MAX_CHAT_LENGTH), at: reqNumber(o, 'at', 0, 1e15) };
  });
}

/** Valida uma mensagem JSON do DataChannel "file". */
export function parseFileMessage(raw: unknown): ParseResult<FileMessage> {
  return guard((): FileMessage => {
    const o = decode(raw, 't', 8 * 1024);
    const id = reqString(o, 'id', 64, TRANSFER_ID);
    const MAX_SIZE = 64 * 1024 ** 3;
    switch (o.t) {
      case 'file-offer':
        return {
          t: 'file-offer',
          id,
          n: reqNumber(o, 'n', 0, 0xffffffff, true),
          name: reqString(o, 'name', 1024),
          size: reqNumber(o, 'size', 0, MAX_SIZE, true),
          sha256: reqString(o, 'sha256', 64, SHA256_HEX),
        };
      case 'file-accept':
        return { t: 'file-accept', id, offset: reqNumber(o, 'offset', 0, MAX_SIZE, true) };
      case 'file-reject':
        return { t: 'file-reject', id, reason: reqString(o, 'reason', 500) };
      case 'file-end':
        return { t: 'file-end', id };
      case 'file-done': {
        const reason = optString(o, 'reason', 500);
        return reason === undefined ? { t: 'file-done', id, ok: reqBool(o, 'ok') } : { t: 'file-done', id, ok: reqBool(o, 'ok'), reason };
      }
      case 'file-cancel':
        return { t: 'file-cancel', id };
      default:
        throw new ProtocolError(`mensagem de arquivo desconhecida: ${String(o.t).slice(0, 40)}`);
    }
  });
}

/** Valida uma mensagem do DataChannel "cursor". */
export function parseCursorMessage(raw: unknown): ParseResult<CursorPosMessage> {
  return guard((): CursorPosMessage => {
    const o = decode(raw, 't', 1024);
    if (o.t !== 'pos') throw new ProtocolError('mensagem de cursor desconhecida');
    // o ponteiro pode sair parcialmente da tela: aceita um pouco fora de 0–1
    return {
      t: 'pos',
      x: reqNumber(o, 'x', -1, 2),
      y: reqNumber(o, 'y', -1, 2),
      v: reqBool(o, 'v'),
      id: reqNumber(o, 'id', 0, 0xffffffff, true),
    };
  });
}

export function encode(msg: ClientMessage | ServerMessage | ControlMessage | CursorPosMessage): string {
  return JSON.stringify(msg);
}

// ---------------------------------------------------------------- utilidades

/** Remove tudo que não é dígito ("123 456-789" → "123456789"). */
export function normalizeHostId(input: string): string {
  return input.replace(/\D/g, '');
}

/** "123456789" → "123 456 789". */
export function formatHostId(id: string): string {
  return HOST_ID_PATTERN.test(id) ? `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}` : id;
}
