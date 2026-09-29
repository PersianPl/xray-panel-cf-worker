/**
 * جایگزین تستیِ WebSocket سمت سرور.
 * فقط همان چیزی را دارد که `relay()` لازم دارد: send/close و سه رویداد.
 */
export class FakeWs {
  readonly sent: Uint8Array[] = [];
  closeCode: number | null = null;
  closeReason = '';

  private listeners = new Map<string, Array<(e: { data: unknown }) => void>>();

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data.slice(0)));
      return;
    }
    this.sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  }

  close(code = 1000, reason = ''): void {
    if (this.closeCode !== null) return;
    this.closeCode = code;
    this.closeReason = reason;
  }

  addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
    const l = this.listeners.get(type);
    if (l) l.push(fn);
    else this.listeners.set(type, [fn]);
  }

  /** یک فریم از سمت کلاینت تزریق می‌کند. */
  emitMessage(data: Uint8Array | ArrayBuffer | string): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data });
  }

  emitClose(): void {
    for (const fn of this.listeners.get('close') ?? []) fn({ data: undefined });
  }

  emitError(): void {
    for (const fn of this.listeners.get('error') ?? []) fn({ data: undefined });
  }

  /** همه‌ی بایت‌های فرستاده‌شده، به‌هم چسبیده. */
  all(): Uint8Array {
    let n = 0;
    for (const s of this.sent) n += s.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const s of this.sent) {
      out.set(s, o);
      o += s.length;
    }
    return out;
  }
}

/** سوکت مقصد جعلی با کنترل دستی روی جریان خواندن. */
export class FakeTarget {
  readonly writes: Uint8Array[] = [];
  isClosed = false;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private queued: Uint8Array[] = [];
  private endRequested = false;
  /** اگر ست شود، هر write با این خطا رد می‌شود. */
  failWrite: Error | null = null;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.ctrl = c;
        for (const b of this.queued) c.enqueue(b);
        this.queued = [];
        if (this.endRequested) c.close();
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.failWrite) throw this.failWrite;
        this.writes.push(chunk.slice(0));
      },
    });
  }

  /** بایت از سمت مقصد به کلاینت. */
  push(b: Uint8Array): void {
    if (this.ctrl) this.ctrl.enqueue(b);
    else this.queued.push(b);
  }

  /** پایان جریان مقصد. */
  end(): void {
    this.endRequested = true;
    if (this.ctrl) {
      try {
        this.ctrl.close();
      } catch {
        /* بسته بوده */
      }
    }
  }

  close(): void {
    this.isClosed = true;
    this.end();
  }

  written(): Uint8Array {
    let n = 0;
    for (const w of this.writes) n += w.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const w of this.writes) {
      out.set(w, o);
      o += w.length;
    }
    return out;
  }
}

/**
 * به موتور اجازه می‌دهد صف رویدادها را خالی کند.
 *
 * باید `setTimeout` باشد نه زنجیره‌ی microtask: مسیر VMess از `crypto.subtle`
 * استفاده می‌کند و آن promiseها در macrotask حل می‌شوند، پس صرفِ `Promise.resolve()`
 * پشت سر هم هیچ‌وقت به آن‌ها نمی‌رسد.
 */
export function tick(n = 4): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  return p;
}
