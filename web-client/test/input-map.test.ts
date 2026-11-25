import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentRect, isSupportedButton, moveRelative, toNormalized, wheelUnits } from '../src/input-map.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('vídeo do mesmo formato ocupa o elemento todo', () => {
  assert.deepEqual(contentRect(1280, 720, 1920, 1080), { x: 0, y: 0, w: 1280, h: 720 });
  const p = toNormalized(640, 360, 1280, 720, 1920, 1080);
  assert.deepEqual(p, { x: 0.5, y: 0.5, inside: true });
});

test('faixas laterais (janela mais larga que o vídeo)', () => {
  // elemento 2000×720, vídeo 16:9 → conteúdo 1280×720 centralizado, faixas de 360 px
  const r = contentRect(2000, 720, 1920, 1080);
  assert.deepEqual(r, { x: 360, y: 0, w: 1280, h: 720 });
  assert.equal(toNormalized(100, 300, 2000, 720, 1920, 1080).inside, false);
  const p = toNormalized(360 + 320, 180, 2000, 720, 1920, 1080);
  close(p.x, 0.25);
  close(p.y, 0.25);
  assert.equal(p.inside, true);
});

test('faixas em cima e embaixo (janela mais alta que o vídeo)', () => {
  const r = contentRect(800, 900, 1600, 900);
  assert.deepEqual(r, { x: 0, y: 225, w: 800, h: 450 });
  const p = toNormalized(800 - 1, 225 + 450 - 1, 800, 900, 1600, 900);
  assert.equal(p.inside, true);
  assert.ok(p.x < 1 && p.y < 1);
  assert.equal(toNormalized(400, 10, 800, 900, 1600, 900).inside, false);
});

test('fora do vídeo é limitado a 0–1 (arrastar para fora)', () => {
  const p = toNormalized(-50, 2000, 1280, 720, 1920, 1080);
  assert.deepEqual(p, { x: 0, y: 1, inside: false });
});

test('tela remota retrato e ultrawide', () => {
  const portrait = toNormalized(960, 540, 1920, 1080, 1080, 1920); // conteúdo 607,5×1080 centralizado
  close(portrait.x, 0.5);
  close(portrait.y, 0.5);
  const wide = toNormalized(0, 1080 / 2, 1920, 1080, 3440, 1440);
  assert.equal(wide.inside, true);
  close(wide.x, 0);
});

test('vídeo sem dimensões (ainda carregando)', () => {
  assert.deepEqual(toNormalized(10, 10, 100, 100, 0, 0), { x: 0, y: 0, inside: false });
});

test('roda: pixels, linhas e acumulação de frações', () => {
  const carry = { x: 0, y: 0 };
  assert.deepEqual(wheelUnits(0, 100, 0, carry), { dx: 0, dy: -120 }); // 1 clique para baixo no Chrome/Windows
  assert.deepEqual(wheelUnits(0, -3, 1, carry), { dx: 0, dy: 120 }); // 3 linhas para cima (Firefox)
  assert.deepEqual(wheelUnits(50, 0, 0, carry), { dx: 60, dy: 0 }); // horizontal para a direita
  // trackpad: deltas pequenos se acumulam
  const c2 = { x: 0, y: 0 };
  assert.deepEqual(wheelUnits(0, 0.4, 0, c2), { dx: 0, dy: 0 });
  assert.deepEqual(wheelUnits(0, 0.5, 0, c2), { dx: 0, dy: -1 });
});

test('botões suportados', () => {
  assert.ok([0, 1, 2, 3, 4].every(isSupportedButton));
  assert.equal(isSupportedButton(5), false);
  assert.equal(isSupportedButton(-1), false);
});

test('mouse travado: deslocamento na escala do vídeo exibido', () => {
  // vídeo exibido com 1280×720: 128 px para a direita = 10% da tela remota
  const p = moveRelative(0.5, 0.5, 128, -72, 1280, 720);
  close(p.x, 0.6);
  close(p.y, 0.4);
});

test('mouse travado: nunca sai da tela remota', () => {
  assert.deepEqual(moveRelative(0.95, 0.02, 5000, -5000, 1280, 720), { x: 1, y: 0 });
  assert.deepEqual(moveRelative(0.01, 0.99, -5000, 5000, 1280, 720), { x: 0, y: 1 });
});

test('mouse travado: valores inválidos não quebram a posição', () => {
  assert.deepEqual(moveRelative(0.3, 0.7, 10, 10, 0, 0), { x: 0.3, y: 0.7 }, 'vídeo ainda sem tamanho');
  assert.deepEqual(moveRelative(0.3, 0.7, Number.NaN, 0, 1280, 720), { x: 0.3, y: 0.7 });
});