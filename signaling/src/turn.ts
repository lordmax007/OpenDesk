import { createHmac } from 'node:crypto';
import type { IceConfig, IceServer } from '@remoto/protocol';
import type { Config } from './config.ts';

/**
 * Credenciais temporárias no formato "TURN REST API" aceito pelo coturn (use-auth-secret):
 * username = "<expira_unix>:<rótulo>", credential = base64(HMAC-SHA1(segredo, username)).
 */
export function turnRestCredentials(secret: string, label: string, ttlSeconds: number, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expires}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/** Monta a configuração ICE entregue ao cliente. `label` vai no username do TURN (aparece nos logs do coturn). */
export function buildIceConfig(config: Config, label: string, nowMs = Date.now()): IceConfig {
  const iceServers: IceServer[] = [];
  if (config.stunUrls.length > 0) iceServers.push({ urls: [...config.stunUrls] });
  const turn = config.turn;
  if (turn) {
    if (turn.secret) {
      iceServers.push({ urls: [...turn.urls], ...turnRestCredentials(turn.secret, label, turn.ttlSeconds, nowMs) });
    } else {
      iceServers.push({ urls: [...turn.urls], username: turn.username, credential: turn.credential });
    }
  }
  return { iceServers, iceTransportPolicy: config.iceTransportPolicy };
}
