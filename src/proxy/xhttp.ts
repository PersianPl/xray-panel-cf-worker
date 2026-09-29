/**
 * آداپتور XHTTP Stream-One برای تبدیل یک درخواست HTTP فول‌دوبلکس به `WsLike`.
 *
 * چرا: هسته‌ی Xray در حالت `stream-one` یک درخواست HTTP (معمولاً POST) می‌فرستد
 * که بدنه‌ی درخواست جریان uplink (کلاینت → سرور) و بدنه‌ی پاسخ جریان downlink
 * (سرور → کلاینت) است.
 *
 * این آداپتور `WsLike` را پیاده می‌کند تا `handleSession` و `relay` بتوانند بدون
 * هیچ تغییری، نشست VLESS/VMess/Trojan را روی XHTTP هم اجرا کنند.
 */
import type { WsLike } from './pipe';

export class XHttpStreamOneAdapter implements WsLike {
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private isClosed = false;
  private cancelReader: (() => void) | null = null;

  constructor(
    private readonly req: Request,
    responseStream: TransformStream<Uint8Array, Uint8Array>,
  ) {
    this.writer = responseStream.writable.getWriter();
    this.startReading();
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.isClosed) return;
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.slice(0));
    } else {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    this.writer.write(bytes).catch(() => this.close());
  }

  close(_code = 1000, _reason = ''): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.cancelReader) {
      this.cancelReader();
      this.cancelReader = null;
    }
    void this.writer.close().catch(() => {});
    this.emit('close');
  }

  addEventListener(type: 'message' | 'close' | 'error', fn: (...args: any[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  private emit(type: string, arg?: unknown): void {
    const list = this.listeners.get(type) ?? [];
    for (const fn of list) {
      try {
        fn(arg);
      } catch {
        /* خطا در شنونده */
      }
    }
  }

  private startReading(): void {
    if (!this.req.body) {
      queueMicrotask(() => this.close());
      return;
    }
    const reader = this.req.body.getReader();
    let aborted = false;
    this.cancelReader = () => {
      aborted = true;
      void reader.cancel().catch(() => {});
    };

    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || aborted) break;
          if (value && value.length > 0) {
            this.emit('message', { data: value });
          }
        }
      } catch (err) {
        if (!aborted) this.emit('error', err);
      } finally {
        if (!this.isClosed) this.close();
      }
    })();
  }
}
