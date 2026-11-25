/** Contador por chave em janela fixa (ex.: falhas de join por IP). */
export class WindowCounter {
  private readonly entries = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs: number) {}

  count(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    return !e || now - e.start >= this.windowMs ? 0 : e.count;
  }

  record(key: string, now = Date.now()): number {
    let e = this.entries.get(key);
    if (!e || now - e.start >= this.windowMs) {
      e = { start: now, count: 0 };
      this.entries.set(key, e);
    }
    return ++e.count;
  }

  sweep(now = Date.now()): void {
    for (const [key, e] of this.entries) if (now - e.start >= this.windowMs) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
