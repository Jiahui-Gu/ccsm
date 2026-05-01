// electron/crash/ring-buffer.ts
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  snapshot(): T[] {
    return this.buf.slice();
  }
  get length(): number {
    return this.buf.length;
  }
}
