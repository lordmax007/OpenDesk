/** Mapeamento puro do lado do cliente (testado em web-client/test). */

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Área ocupada pelo vídeo dentro do elemento com `object-fit: contain` (com faixas pretas). */
export function contentRect(elW: number, elH: number, vidW: number, vidH: number): ContentRect {
  if (!(elW > 0 && elH > 0 && vidW > 0 && vidH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const s = Math.min(elW / vidW, elH / vidH);
  const w = vidW * s;
  const h = vidH * s;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/**
 * Ponto do mouse (relativo ao elemento) → posição normalizada 0–1 na tela remota.
 * `inside` é falso sobre as faixas pretas; `x`/`y` vêm limitados a 0–1 (útil ao arrastar para fora).
 */
export function toNormalized(
  px: number,
  py: number,
  elW: number,
  elH: number,
  vidW: number,
  vidH: number,
): { x: number; y: number; inside: boolean } {
  const r = contentRect(elW, elH, vidW, vidH);
  if (r.w === 0) return { x: 0, y: 0, inside: false };
  const nx = (px - r.x) / r.w;
  const ny = (py - r.y) / r.h;
  const inside = nx >= 0 && nx < 1 && ny >= 0 && ny < 1;
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  return { x: clamp(nx), y: clamp(ny), inside };
}

/**
 * Mouse travado (Pointer Lock): o navegador só informa o deslocamento (movementX/Y, em px de tela).
 * Soma ao ponteiro virtual na escala em que o vídeo aparece, limitado à tela remota.
 */
export function moveRelative(
  x: number,
  y: number,
  dx: number,
  dy: number,
  contentW: number,
  contentH: number,
): { x: number; y: number } {
  if (!(contentW > 0 && contentH > 0)) return { x, y };
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5);
  return { x: clamp(x + (dx || 0) / contentW), y: clamp(y + (dy || 0) / contentH) };
}

/** Converte WheelEvent em unidades do Windows (120 = um clique; positivo = para cima/direita). */
export function wheelUnits(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  carry: { x: number; y: number },
): { dx: number; dy: number } {
  // Chrome no Windows: 100 px por clique da roda. Linhas: 3 por clique. Página: 1 por clique.
  const factor = deltaMode === 1 ? 40 : deltaMode === 2 ? 120 : 1.2;
  carry.x += deltaX * factor;
  carry.y += -deltaY * factor;
  const dx = Math.trunc(carry.x) || 0; // "|| 0" evita -0
  const dy = Math.trunc(carry.y) || 0;
  carry.x -= dx;
  carry.y -= dy;
  return { dx, dy };
}

/** Botão do PointerEvent (0 esq, 1 meio, 2 dir, 3 voltar, 4 avançar) — mesma numeração do protocolo. */
export function isSupportedButton(button: number): boolean {
  return Number.isInteger(button) && button >= 0 && button <= 4;
}
