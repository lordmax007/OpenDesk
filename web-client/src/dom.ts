export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Elemento #${id} não encontrado`);
  return e as T;
}
