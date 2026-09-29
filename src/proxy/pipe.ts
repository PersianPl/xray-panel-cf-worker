/**
 * رله‌ی دوطرفه‌ی WebSocket ↔ سوکت TCP، با شمارش بایت.
 *
 * سه پروتکل سه رفتار دارند و همه با یک `StreamCodec` یکسان‌سازی می‌شوند:
 *   • VLESS  → بعد از هدر، بایت خام؛ پاسخ با پیشوند دوبایتی `00 00`
 *   • Trojan → بایت خام در هر دو جهت، بدون هیچ هدر پاسخ
 *   • VMess  → فریم‌بندی chunk در هر دو جهت (ماسک SHAKE، AEAD، پدینگ)
 *
 * محدودیت‌های Workers که اینجا اثر دارند:
 *   • هدر پاسخ باید به **اولین** بسته‌ی داده چسبانده شود؛ فرستادن جداگانه‌اش یک
 *     فریم WS کوچکِ قابل‌انگشت‌نگاری می‌سازد و یک round-trip اضافه هم دارد.
 *   • شمارنده‌ها در حافظه‌ی isolate جمع می‌شوند و یک‌بار در پایان با `waitUntil`
 *     به D1 می‌روند؛ نوشتن per-packet هم CPU می‌برد و هم سهمیه‌ی D1.
 */
import { concat } from '../lib/bytes';
import {
  ChunkStream,
  buildVmessResponseHeader,
  maxPayload,
  writeAll,
  writeEndChunk,
  type BodyCodec,
  type VmessSession,
} from './vmess';

const EMPTY: Uint8Array = new Uint8Array(0);

/** شمارنده‌ی ترافیک یک نشست. */
export interface Counter {
  /** بایت‌های کلاینت → مقصد. */
  up: number;
  /** بایت‌های مقصد → کلاینت. */
  down: number;
}

export function newCounter(): Counter {
  return { up: 0, down: 0 };
}

/**
 * تبدیل بایت بین سیمِ کلاینت و سوکت مقصد.
 * پیاده‌سازی‌ها stateful هستند (VMess شمارنده‌ی nonce و جریان SHAKE دارد).
 */
export interface StreamCodec {
  /** خام از کلاینت → تکه‌های مقصد. `null` یعنی داده‌ی نامعتبر و بستن نشست. */
  decode(b: Uint8Array): Promise<Uint8Array[] | null>;
  /** از مقصد → بایتِ سیمِ کلاینت. */
  encode(b: Uint8Array): Promise<Uint8Array>;
  /** بایت پایانیِ downlink (فقط VMess فریم پایانی دارد). */
  finish(): Promise<Uint8Array>;
  /** آیا کلاینت جریان uplink را بسته است (فریم پایانیِ VMess). */
  readonly ended: boolean;
  /** بیشترین بایتِ payload در یک فریم downlink. */
  readonly maxDownlink: number;
}

/** عبور خام — VLESS و Trojan. */
export class RawCodec implements StreamCodec {
  readonly ended = false;
  readonly maxDownlink = 0x7fffffff;

  async decode(b: Uint8Array): Promise<Uint8Array[]> {
    return b.length === 0 ? [] : [b];
  }
  async encode(b: Uint8Array): Promise<Uint8Array> {
    return b;
  }
  async finish(): Promise<Uint8Array> {
    return EMPTY;
  }
}

/** فریم‌بندی VMess در هر دو جهت. */
export class VmessCodec implements StreamCodec {
  private readonly uplink: ChunkStream;
  private readonly downCodec: BodyCodec;

  constructor(session: VmessSession) {
    this.uplink = new ChunkStream(session.request);
    this.downCodec = session.response;
  }

  get ended(): boolean {
    return this.uplink.done;
  }

  get maxDownlink(): number {
    return maxPayload(this.downCodec);
  }

  async decode(b: Uint8Array): Promise<Uint8Array[] | null> {
    this.uplink.push(b);
    return this.uplink.drain();
  }

  async encode(b: Uint8Array): Promise<Uint8Array> {
    // writeAll خودش payload بزرگ را به chunkهای مجاز می‌شکند.
    return writeAll(this.downCodec, b);
  }

  async finish(): Promise<Uint8Array> {
    return writeEndChunk(this.downCodec);
  }
}

/** هدر پاسخ VMess (شامل AEAD) — برای چسباندن به اولین بسته‌ی downlink. */
export function vmessResponsePrefix(session: VmessSession): Promise<Uint8Array> {
  return buildVmessResponseHeader(session);
}

/** پیوند دو بایت‌آرایه، بدون کپیِ بی‌جا وقتی یکی خالی است. */
export function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return concat(a, b);
}

/** یک انتهای WebSocket که رله با آن کار می‌کند (زیرمجموعه‌ی WebSocket واقعی). */
export interface WsLike {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}

/** سوکت مقصد — زیرمجموعه‌ی `cloudflare:sockets`.Socket. */
export interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

/**
 * تک‌شنونده‌ی فریم‌های WebSocket، با تحویل به «مصرف‌کننده‌ی جاری».
 *
 * چرا لازم است: نشست دو فاز دارد — اول پارس هدر، بعد رله. اگر هر فاز شنونده‌ی
 * خودش را اضافه کند، فریم‌هایی که در فاصله‌ی بین «هدر کامل شد» و «رله راه افتاد»
 * (که یک `await dial()` کامل طول می‌کشد) می‌رسند بی‌صاحب می‌مانند و اولین چند
 * بایت درخواست گم می‌شود. با یک شنونده و صفِ replay، هیچ فریمی جا نمی‌ماند و
 * ترتیب هم حفظ می‌شود.
 */
export class WsInbox {
  private queue: Uint8Array[] = [];
  private consumer: ((b: Uint8Array) => void) | null = null;

  constructor(ws: WsLike) {
    ws.addEventListener('message', (e: { data: unknown }) => {
      const b = toBytes(e.data);
      if (b === null || b.length === 0) return;
      const c = this.consumer;
      if (c) c(b);
      else this.queue.push(b);
    });
  }

  /** مصرف‌کننده را وصل می‌کند و هر چه در صف مانده را به‌ترتیب پخش می‌کند. */
  attach(fn: (b: Uint8Array) => void): void {
    this.consumer = fn;
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const b of pending) fn(b);
  }

  /** مصرف‌کننده را برمی‌دارد؛ از این پس فریم‌ها در صف می‌مانند. */
  detach(): void {
    this.consumer = null;
  }
}

export interface RelayOptions {
  ws: WsLike;
  socket: SocketLike;
  codec: StreamCodec;
  /**
   * صندوق فریم‌های WS. اگر داده شود، رله از آن می‌خواند (و فریم‌های صف‌شده‌ی
   * فاز هدر را هم می‌گیرد). اگر داده نشود، خودش یکی می‌سازد.
   */
  inbox?: WsInbox;
  /** بایت‌هایی که قبل از هر داده‌ای روی سوکت می‌رود (هدر Trojan-relay). */
  preamble?: Uint8Array;
  /** بایت‌هایی که به اولین فریم downlink چسبانده می‌شود (هدر پاسخ پروتکل). */
  responsePrefix?: Uint8Array;
  /** بقیه‌ی اولین بسته‌ی کلاینت که بعد از هدر آمده. */
  firstPayload?: Uint8Array;
  counter?: Counter;
  /** بعد از این مدت بی‌فعالیتی نشست بسته می‌شود. */
  idleMs?: number;
}

/** پیش‌فرض بی‌فعالیتی — کمی کمتر از سقف عملی WS در لبه‌ی CF. */
const IDLE_MS = 100_000;

/**
 * رله را برقرار می‌کند و تا بسته‌شدن یکی از دو طرف برنمی‌گردد.
 *
 * چیدمان مهم: uplink با شنونده‌ی رویداد `message` کار می‌کند (نه با
 * `ws.readable`) چون فریم‌های WebSocket در Workers فقط از این راه می‌آیند؛
 * downlink با یک حلقه‌ی reader روی `socket.readable`.
 */
export async function relay(opts: RelayOptions): Promise<Counter> {
  const { ws, socket, codec } = opts;
  const counter = opts.counter ?? newCounter();
  const idleMs = opts.idleMs ?? IDLE_MS;

  const writer = socket.writable.getWriter();
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const shutdown = (code = 1000, reason = ''): void => {
    if (closed) return;
    closed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    void writer.close().catch(() => {});
    void Promise.resolve(socket.close()).catch(() => {});
    try {
      ws.close(code, reason);
    } catch {
      /* از قبل بسته شده */
    }
    resolveDone();
  };

  const touch = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(1001, 'idle'), idleMs);
  };
  touch();

  // ── uplink: کلاینت → مقصد
  // نوشتن‌ها با یک زنجیره‌ی promise ترتیبی می‌شوند؛ writer.write موازی مجاز نیست.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (b: Uint8Array): void => {
    pending = pending.then(() => writer.write(b)).catch(() => shutdown(1011, 'write'));
  };

  if (opts.preamble && opts.preamble.length) enqueue(opts.preamble);
  if (opts.firstPayload && opts.firstPayload.length) {
    const parts = await codec.decode(opts.firstPayload);
    if (parts === null) {
      shutdown(1002, 'protocol');
      return counter;
    }
    for (const p of parts) {
      counter.up += p.length;
      enqueue(p);
    }
  }

  const inbox = opts.inbox ?? new WsInbox(ws);
  inbox.attach((raw: Uint8Array) => {
    if (closed) return;
    touch();
    // رمزگشایی هم async است؛ همان زنجیره ترتیب را حفظ می‌کند.
    pending = pending
      .then(async () => {
        const parts = await codec.decode(raw);
        if (parts === null) {
          shutdown(1002, 'protocol');
          return;
        }
        for (const p of parts) {
          counter.up += p.length;
          await writer.write(p);
        }
        // فریم پایانیِ VMess: uplink تمام شده، ولی downlink باید ادامه بدهد.
        if (codec.ended) await writer.close().catch(() => {});
      })
      .catch(() => shutdown(1011, 'uplink'));
  });
  ws.addEventListener('close', () => shutdown());
  ws.addEventListener('error', () => shutdown(1011, 'ws-error'));

  // ── downlink: مقصد → کلاینت
  void (async () => {
    const reader = socket.readable.getReader();
    let prefix = opts.responsePrefix ?? EMPTY;
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (!value || value.length === 0) continue;
        if (closed) break;
        touch();
        counter.down += value.length;
        const framed = await codec.encode(value);
        ws.send(sliceOf(join(prefix, framed)));
        prefix = EMPTY;
      }
      // اگر هیچ بایتی از مقصد نیامد، هدر پاسخ باید جداگانه برود وگرنه
      // کلاینت هیچ‌وقت دست‌دادن پروتکل را کامل‌شده نمی‌بیند.
      if (!closed) {
        const tail = join(prefix, await codec.finish());
        if (tail.length) ws.send(sliceOf(tail));
      }
    } catch {
      /* خطای خواندن = پایان نشست */
    } finally {
      shutdown();
    }
  })();

  await done;
  return counter;
}

/** داده‌ی رویداد WS را به بایت تبدیل می‌کند (متن هم ممکن است بیاید). */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

/**
 * یک ArrayBuffer دقیقاً به اندازه‌ی داده می‌سازد.
 * `ws.send(view)` در Workers کل بافر پشتی را می‌فرستد، پس subarray بدون کپی
 * می‌تواند بایت اضافه بفرستد و جریان را خراب کند.
 */
function sliceOf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
