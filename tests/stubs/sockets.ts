/**
 * جایگزین تستیِ `cloudflare:sockets`.
 *
 * در تست‌ها با alias در [vitest.config.ts](../../vitest.config.ts) جای ماژول
 * واقعی می‌نشیند تا بتوانیم رفتار هر اتصال را دقیق کنترل کنیم: باز شدن، شکست،
 * معلق ماندن (برای تست timeout)، و پاسخ دادن به بایت‌های نوشته‌شده.
 */

export interface Attempt {
  hostname: string;
  port: number;
  tls: boolean;
}

export type Responder = (chunk: Uint8Array, sock: FakeSocket) => void;

export interface OpenBehavior {
  kind: 'open';
  /** بایت‌هایی که بی‌درنگ به سمت خواننده فرستاده می‌شود. */
  initial?: Uint8Array[];
  /** برای هر write صدا زده می‌شود؛ می‌تواند با `sock.push()` جواب بدهد. */
  onWrite?: Responder;
  /** تأخیر باز شدن (ms) — برای تست مسابقه‌ی موازی. */
  delayMs?: number;
}
export interface FailBehavior {
  kind: 'fail';
  error?: string;
  delayMs?: number;
}
/** هرگز settle نمی‌شود — تست timeout. */
export interface HangBehavior {
  kind: 'hang';
}
export type Behavior = OpenBehavior | FailBehavior | HangBehavior;

/** همه‌ی تلاش‌های connect به‌ترتیب، برای assert کردن مسیرها. */
export const attempts: Attempt[] = [];
/** همه‌ی سوکت‌های ساخته‌شده، برای بررسی بسته شدن بازنده‌ها. */
export const sockets: FakeSocket[] = [];

let router: (a: Attempt) => Behavior = () => ({ kind: 'open' });

export function setRouter(fn: (a: Attempt) => Behavior): void {
  router = fn;
}

export function reset(): void {
  attempts.length = 0;
  sockets.length = 0;
  router = () => ({ kind: 'open' });
}

export class FakeSocket {
  readonly writes: Uint8Array[] = [];
  closed: Promise<void>;
  opened: Promise<{ remoteAddress: string; localAddress: string }>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  isClosed = false;

  private pushChunk!: (b: Uint8Array) => void;
  private endStream!: () => void;
  private resolveClosed!: () => void;

  constructor(
    readonly attempt: Attempt,
    behavior: Behavior,
  ) {
    let pending: Uint8Array[] = [];
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ended = false;

    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
        for (const b of pending) c.enqueue(b);
        pending = [];
        if (ended) c.close();
      },
    });
    this.pushChunk = (b) => {
      if (ctrl) ctrl.enqueue(b);
      else pending.push(b);
    };
    this.endStream = () => {
      ended = true;
      if (ctrl) {
        try {
          ctrl.close();
        } catch {
          /* قبلاً بسته شده */
        }
      }
    };

    const onWrite = behavior.kind === 'open' ? behavior.onWrite : undefined;
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writes.push(chunk.slice(0));
        if (onWrite) onWrite(chunk, this);
      },
    });

    this.closed = new Promise<void>((res) => {
      this.resolveClosed = res;
    });

    if (behavior.kind === 'hang') {
      this.opened = new Promise(() => {});
      return;
    }

    if (behavior.kind === 'fail') {
      const err = new Error(behavior.error ?? `اتصال به ${attempt.hostname}:${attempt.port} رد شد`);
      this.opened = behavior.delayMs
        ? new Promise((_, rej) => setTimeout(() => rej(err), behavior.delayMs))
        : Promise.reject(err);
      // تا وقتی کسی await نکرده، unhandled به‌حساب نیاید.
      void this.opened.catch(() => {});
      return;
    }

    const info = { remoteAddress: `${attempt.hostname}:${attempt.port}`, localAddress: '127.0.0.1:1' };
    this.opened = behavior.delayMs
      ? new Promise((res) => setTimeout(() => res(info), behavior.delayMs))
      : Promise.resolve(info);
    for (const b of behavior.initial ?? []) this.pushChunk(b);
  }

  /** بایت به سمت خواننده می‌فرستد (پاسخ سرور جعلی). */
  push(b: Uint8Array): void {
    this.pushChunk(b);
  }

  /** انتهای جریان خواندن. */
  end(): void {
    this.endStream();
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.endStream();
    this.resolveClosed();
  }

  startTls(): FakeSocket {
    return this;
  }

  /** همه‌ی بایت‌های نوشته‌شده، به‌هم چسبیده. */
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

export function connect(
  address: string | { hostname: string; port: number },
  options?: { secureTransport?: string; allowHalfOpen?: boolean },
): FakeSocket {
  const a: Attempt =
    typeof address === 'string'
      ? { hostname: address.split(':')[0]!, port: Number(address.split(':')[1] ?? 443), tls: options?.secureTransport === 'on' }
      : { hostname: address.hostname, port: address.port, tls: options?.secureTransport === 'on' };
  attempts.push(a);
  const s = new FakeSocket(a, router(a));
  sockets.push(s);
  return s;
}
