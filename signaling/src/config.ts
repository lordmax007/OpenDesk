import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TurnConfig {
  urls: string[];
  /** Segredo compartilhado com o coturn (use-auth-secret) → credenciais temporárias. */
  secret?: string;
  /** Credenciais estáticas (alternativa ao segredo). */
  username?: string;
  credential?: string;
  ttlSeconds: number;
}

export interface Config {
  host: string;
  port: number;
  wsPath: string;
  staticDir: string | null;
  /** Para onde /baixar redireciona (ex.: o .exe numa versão do GitHub). Sem isto, /baixar não existe. */
  downloadUrl: string | null;
  allowedOrigins: string[] | null;
  trustProxy: boolean;
  stunUrls: string[];
  turn: TurnConfig | null;
  iceTransportPolicy: 'all' | 'relay';
  idReservationTtlMs: number;
  heartbeatMs: number;
  joinFailLimit: number;
  joinFailWindowMs: number;
  msgRateLimit: number;
  msgRateWindowMs: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** signaling/src ou signaling/dist → web-client/dist */
export const DEFAULT_STATIC_DIR = path.resolve(here, '../../web-client/dist');
export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Variável ${name} inválida: "${raw}" (inteiro entre ${min} e ${max})`);
  }
  return n;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): Config {
  const wsPath = env.WS_PATH?.trim() || '/ws';
  if (!wsPath.startsWith('/')) throw new Error('WS_PATH deve começar com "/"');

  const stunUrls = env.STUN_URLS === undefined ? [DEFAULT_STUN] : list(env.STUN_URLS);
  for (const u of stunUrls) {
    if (!/^stuns?:\S+$/.test(u)) throw new Error(`URL STUN inválida: ${u}`);
  }

  let turn: TurnConfig | null = null;
  const turnUrls = list(env.TURN_URLS);
  if (turnUrls.length > 0) {
    for (const u of turnUrls) {
      if (!/^turns?:\S+$/.test(u)) throw new Error(`URL TURN inválida: ${u}`);
    }
    const secret = env.TURN_SECRET || undefined;
    const username = env.TURN_USERNAME || undefined;
    const credential = env.TURN_CREDENTIAL || undefined;
    if (!secret && !(username && credential)) {
      throw new Error('TURN_URLS exige TURN_SECRET ou TURN_USERNAME + TURN_CREDENTIAL');
    }
    turn = { urls: turnUrls, secret, username, credential, ttlSeconds: int(env, 'TURN_TTL_SECONDS', 3600, 60, 86_400 * 7) };
  }

  const policy = env.ICE_TRANSPORT_POLICY?.trim() || 'all';
  if (policy !== 'all' && policy !== 'relay') throw new Error('ICE_TRANSPORT_POLICY deve ser "all" ou "relay"');
  if (policy === 'relay' && !turn) throw new Error('ICE_TRANSPORT_POLICY=relay exige TURN_URLS');

  const origins = list(env.ALLOWED_ORIGINS);

  const downloadUrl = env.DOWNLOAD_URL?.trim() || null;
  if (downloadUrl !== null) {
    let ok = false;
    try {
      ok = new URL(downloadUrl).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`DOWNLOAD_URL inválida: ${downloadUrl} (use um endereço https://)`);
  }

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env, 'PORT', 8080, 0, 65_535),
    wsPath,
    staticDir: env.STATIC_DIR === undefined ? DEFAULT_STATIC_DIR : env.STATIC_DIR.trim() ? path.resolve(env.STATIC_DIR) : null,
    downloadUrl,
    allowedOrigins: origins.length > 0 ? origins : null,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    stunUrls,
    turn,
    iceTransportPolicy: policy,
    idReservationTtlMs: int(env, 'ID_RESERVATION_HOURS', 24, 0, 24 * 365) * 3_600_000,
    heartbeatMs: int(env, 'HEARTBEAT_SECONDS', 30, 1, 3600) * 1000,
    joinFailLimit: int(env, 'JOIN_FAIL_LIMIT', 10, 1, 10_000),
    joinFailWindowMs: int(env, 'JOIN_FAIL_WINDOW_SECONDS', 60, 1, 86_400) * 1000,
    msgRateLimit: int(env, 'MSG_RATE_LIMIT', 300, 1, 1_000_000),
    msgRateWindowMs: int(env, 'MSG_RATE_WINDOW_SECONDS', 10, 1, 3600) * 1000,
  };
}
