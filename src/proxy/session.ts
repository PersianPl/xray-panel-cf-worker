/**
 * هندلر نشست WebSocket — از فریم اول تا بستن اتصال.
 *
 * جریان کار:
 *   1. فریم اول را می‌گیرد (یا از early-data در هدر `Sec-WebSocket-Protocol`)
 *   2. پروتکل را پارس می‌کند و کاربر را از `ClientStore` پیدا می‌کند
 *   3. سقف‌ها را می‌سنجد (فعال بودن، انقضا، ترافیک، limit_ip)
 *   4. `dial()` را با تنظیمات همان کاربر صدا می‌زند
 *   5. `relay()` را برقرار می‌کند و در پایان مصرف را تحویل `onUsage` می‌دهد
 *
 * چرا فریم اول جدا مدیریت می‌شود: هدر هر سه پروتکل ممکن است در چند فریم WS
 * بیاید (به‌ویژه VMess که هدر AEADش ۵۸+ بایت است)، پس تا کامل شدن هدر بافر
 * می‌کنیم و فقط بعدش رله را راه می‌اندازیم.
 */
import { concat } from '../lib/bytes';
import { b64decode } from '../lib/crypto';
import { dial, DialError, type DialOptions } from './dial';
import {
  RawCodec,
  VmessCodec,
  WsInbox,
  join,
  newCounter,
  relay,
  vmessResponsePrefix,
  type Counter,
  type SocketLike,
  type StreamCodec,
  type WsLike,
} from './pipe';
import { parseTrojanRequest } from './trojan';
import { parseVlessRequest } from './vless';
import { VMESS_MIN_PREFIX, newVmessSession, openVmessRequest, tryAuthId } from './vmess';
import type { ParsedRequest, Proto, Target } from './types';

/** بیشترین بایتی که برای کامل شدن هدر بافر می‌شود — جلوگیری از سوءاستفاده. */
const MAX_HEADER_BUFFER = 4096;
/** فرصت رسیدن هدر کامل. */
const HEADER_TIMEOUT_MS = 8000;

/** یک کاربرِ تطبیق‌یافته با تنظیمات مؤثرش. */
export interface MatchedClient {
  clientId: number;
  inboundId: number;
  name: string;
  /** تنظیمات دیال مؤثر (ادغام سراسری + اختصاصی کاربر). */
  dial: DialOptions;
  /** اگر مصرف از سقف گذشته یا منقضی شده، دلیلِ رد. */
  reject?: string;
}

/** منبع کاربران — پیاده‌سازی واقعی روی D1، در تست جعلی. */
export interface ClientStore {
  /** VLESS/VMess: تطبیق با UUID خام ۱۶ بایتی. */
  byUuid(uuid: Uint8Array): Promise<MatchedClient | null>;
  /** Trojan: تطبیق با هگزِ SHA-224 رمز. */
  byTrojanKey(hashHex: string): Promise<MatchedClient | null>;
  /** VMess: cmdKeyهای همه‌ی کاربرانِ فعال برای تطبیق authID. */
  vmessCandidates(): Promise<Array<{ uuid: Uint8Array; cmdKey: Uint8Array; authIdKey: Uint8Array }>>;
}

/** خروجی نشست، برای ثبت آمار و لاگ. */
export interface SessionResult {
  ok: boolean;
  /** دلیل شکست، اگر نشست برقرار نشد. */
  reason?: string;
  client?: MatchedClient;
  target?: Target;
  proto?: Proto;
  /** کدام مسیر دیال جواب داد. */
  via?: string;
  usage: Counter;
}

export interface SessionOptions {
  ws: WsLike;
  store: ClientStore;
  /** تنظیمات دیال سراسری؛ تنظیمات کاربر روی آن سوار می‌شود. */
  dialDefaults?: DialOptions;
  /** early-data از هدر `sec-websocket-protocol` یا `?ed=`. */
  earlyData?: Uint8Array | null;
  /** IP کلاینت برای limit_ip و لاگ. */
  ip?: string;
  /** برای تست: جایگزین `dial`. */
  dialFn?: typeof dial;
  headerTimeoutMs?: number;
  idleMs?: number;
}

/**
 * فریم‌های اول را جمع می‌کند تا هدر پروتکل کامل شود.
 * `feed` را هر بار که فریمی رسید صدا می‌زنیم؛ `null` یعنی «هنوز کامل نیست».
 */
class HeaderBuffer {
  private buf: Uint8Array = new Uint8Array(0);

  constructor(initial?: Uint8Array | null) {
    if (initial && initial.length) this.buf = initial;
  }

  get bytes(): Uint8Array {
    return this.buf;
  }

  get length(): number {
    return this.buf.length;
  }

  push(b: Uint8Array): void {
    this.buf = this.buf.length === 0 ? b : concat(this.buf, b);
  }
}

/** نتیجه‌ی تلاش برای پارس هدر از بایت‌های موجود. */
type ParseOutcome =
  | { kind: 'need-more' }
  | { kind: 'bad'; reason: string }
  | {
      kind: 'ok';
      request: ParsedRequest;
      client: MatchedClient;
      codec: StreamCodec;
      responsePrefix: Uint8Array;
      /**
       * بایت‌های مصرف‌شده‌ی هدر. لازم است چون بافر ممکن است **بعد از** شروع
       * پارس هم رشد کند؛ با این عدد، بقیه‌ی بافرِ *فعلی* به رله می‌رسد و هیچ
       * بایتی گم نمی‌شود (`request.rest` فقط به snapshot زمان پارس اشاره دارد).
       */
      consumed: number;
    };

/**
 * نتیجه‌ی تلاشِ یک پروتکل. تفکیک این حالت‌ها لازم است چون خروجی نهایی
 * وقتی معنی دارد که بدانیم «نشد» از کدام جنس بود:
 *   • `no-match`  → قطعاً این پروتکل نیست، سراغ بعدی
 *   • `need-more` → می‌تواند همین باشد، فقط بایت کم است
 *   • `auth-fail` → ساختار درست بود ولی کاربری پیدا نشد؛ قطعی است
 *   • `ok`/`bad`  → تصمیم نهایی
 */
type Attempt =
  | { kind: 'no-match' }
  | { kind: 'need-more' }
  | { kind: 'auth-fail'; reason: string }
  | { kind: 'bad'; reason: string }
  | {
      kind: 'ok';
      request: ParsedRequest;
      client: MatchedClient;
      codec: StreamCodec;
      responsePrefix: Uint8Array;
      consumed: number;
    };

const EMPTY: Uint8Array = new Uint8Array(0);

/** بایت‌های مصرف‌شده‌ی هدر از طول دنباله‌ی باقی‌مانده. */
function consumedOf(b: Uint8Array, rest: Uint8Array | null): number {
  return b.length - (rest?.length ?? 0);
}

/**
 * هدر را با هر سه پروتکل امتحان می‌کند.
 *
 * ترتیب بر اساس «چقدر ارزان می‌توان رد کرد» است:
 *   • VLESS ارزان‌ترین (بایت اول باید صفر باشد و UUID خام در جاست)
 *   • Trojan فقط یک regex روی ۵۶ بایت اول می‌خواهد
 *   • VMess آخر، چون تطبیق authID برای هر کاندید یک AES-ECB لازم دارد
 *
 * `only` اگر داده شود، فقط همان پروتکل امتحان می‌شود (مسیر inbound مشخص است).
 */
export async function parseHeader(b: Uint8Array, store: ClientStore, only?: Proto): Promise<ParseOutcome> {
  if (b.length === 0) return { kind: 'need-more' };

  const attempts: Attempt[] = [];
  if (!only || only === 'vless') attempts.push(await tryVless(b, store));
  if (!only || only === 'trojan') attempts.push(await tryTrojan(b, store));
  if (!only || only === 'vmess') attempts.push(await tryVmess(b, store));

  let authFail: string | null = null;
  let needMore = false;
  for (const a of attempts) {
    if (a.kind === 'ok' || a.kind === 'bad') return a;
    if (a.kind === 'need-more') needMore = true;
    else if (a.kind === 'auth-fail') authFail ??= a.reason;
  }

  // «بایت کم است» بر «کاربر پیدا نشد» مقدم است: پروتکلی که می‌تواند با بایت
  // بیشتر جواب بدهد نباید قربانیِ تطبیقِ تصادفیِ پروتکل دیگری شود.
  if (needMore) return { kind: 'need-more' };
  if (authFail !== null) return { kind: 'bad', reason: authFail };
  if (b.length < MIN_DECISIVE) return { kind: 'need-more' };
  return { kind: 'bad', reason: 'هیچ پروتکلی تطبیق نداد' };
}

/** تا این اندازه، «تطبیق نشد» می‌تواند فقط «کامل نشده» باشد. */
const MIN_DECISIVE = 64;

async function tryVless(b: Uint8Array, store: ClientStore): Promise<Attempt> {
  if (b[0] !== 0) return { kind: 'no-match' };
  if (b.length < 1 + 16 + 1 + 1 + 3) return { kind: 'need-more' };

  const req = parseVlessRequest(b, () => true);
  if (!req) {
    // بایت اول صفر بود ولی ساختار نخورد: یا ناقص است یا VLESS نیست.
    return b.length < MIN_DECISIVE ? { kind: 'need-more' } : { kind: 'no-match' };
  }

  const matched = await store.byUuid(b.subarray(1, 17));
  if (!matched) return { kind: 'auth-fail', reason: 'UUID ناشناس' };
  if (matched.reject) return { kind: 'bad', reason: matched.reject };

  return {
    kind: 'ok',
    request: req,
    client: matched,
    codec: new RawCodec(),
    responsePrefix: req.responseHeader ?? EMPTY,
    consumed: consumedOf(b, req.rest),
  };
}

async function tryTrojan(b: Uint8Array, store: ClientStore): Promise<Attempt> {
  // مهم: با بایت‌هایی که *داریم* رد می‌کنیم، نه با انتظارِ ۵۶ بایت کامل.
  // هش Trojan ۵۶ کاراکتر هگز اسکی است، پس هر پیشوندی که هگز نباشد قطعاً
  // Trojan نیست. بدون این، یک هدر کوتاهِ VLESS (که با 0x00 شروع می‌شود) باعث
  // می‌شد Trojan «need-more» بدهد و ردِ قطعیِ VLESS را بپوشاند.
  const n = Math.min(b.length, 56);
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    const isHex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
    if (!isHex) return { kind: 'no-match' };
  }
  if (b.length < 56) return { kind: 'need-more' };

  const head = new TextDecoder().decode(b.subarray(0, 56)).toLowerCase();
  const matched = await store.byTrojanKey(head);
  if (!matched) return { kind: 'auth-fail', reason: 'رمز Trojan نامعتبر' };
  if (matched.reject) return { kind: 'bad', reason: matched.reject };

  const req = parseTrojanRequest(b, (h) => h === head);
  if (!req) return { kind: 'need-more' };

  return {
    kind: 'ok',
    request: req,
    client: matched,
    codec: new RawCodec(),
    responsePrefix: EMPTY,
    consumed: consumedOf(b, req.rest),
  };
}

async function tryVmess(b: Uint8Array, store: ClientStore): Promise<Attempt> {
  // authID فقط ۱۶ بایت اول را می‌خواهد؛ پس «VMess نیست» را می‌توان بدون هدر
  // کامل و قطعی تشخیص داد. اگر این را به VMESS_MIN_PREFIX گره بزنیم، هر بافر
  // کوتاهی «need-more» می‌شود و ردِ قطعیِ پروتکل‌های دیگر را هم بلوکه می‌کند.
  if (b.length < 16) return { kind: 'need-more' };

  const authId = b.subarray(0, 16);
  const now = Math.floor(Date.now() / 1000);
  const candidates = await store.vmessCandidates();

  for (const c of candidates) {
    if (!tryAuthId(c.authIdKey, authId, now)) continue;

    // این کاربرِ ماست؛ از اینجا به بعد هدر کامل لازم است.
    if (b.length < VMESS_MIN_PREFIX) return { kind: 'need-more' };
    const opened = await openVmessRequest(b, c.cmdKey);
    if (opened.kind === 'need-more') return { kind: 'need-more' };
    if (opened.kind === 'bad') return { kind: 'bad', reason: `vmess: ${opened.reason}` };

    const matched = await store.byUuid(c.uuid);
    if (!matched) return { kind: 'auth-fail', reason: 'کاربر VMess پیدا نشد' };
    if (matched.reject) return { kind: 'bad', reason: matched.reject };

    // mux (v1.mux.cool) روی Worker پیاده نمی‌شود: فریم‌بندی mux چند اتصال
    // همزمان می‌خواهد که با سقف ۶ اتصالیِ CF نمی‌سازد.
    if (opened.header.mux) return { kind: 'bad', reason: 'mux پشتیبانی نمی‌شود' };

    const session = await newVmessSession(opened.header);
    return {
      kind: 'ok',
      request: {
        proto: 'vmess',
        target: opened.header.target,
        responseHeader: null,
        rest: b.subarray(opened.consumed),
        udp: opened.header.packet,
      },
      client: matched,
      codec: new VmessCodec(session),
      responsePrefix: await vmessResponsePrefix(session),
      consumed: opened.consumed,
    };
  }

  // هیچ authID تطبیق نکرد → قطعاً VMess نیست.
  return { kind: 'no-match' };
}

/**
 * نشست را از اول تا آخر می‌گرداند.
 *
 * تا کامل شدن هدر، فریم‌ها بافر می‌شوند؛ بعد از آن رله برقرار می‌شود و این تابع
 * تا بسته شدن یکی از دو طرف برنمی‌گردد. صداکننده باید نتیجه را با `waitUntil`
 * به D1 بنویسد.
 */
export async function handleSession(opts: SessionOptions): Promise<SessionResult> {
  const { ws, store } = opts;
  const usage = newCounter();
  const buffer = new HeaderBuffer(opts.earlyData);

  // یک صندوقِ مشترک برای هر دو فاز (هدر و رله). فریم‌هایی که در فاصله‌ی
  // «هدر کامل شد» تا «دیال تمام شد» می‌رسند در صف می‌مانند و به رله می‌رسند.
  const inbox = new WsInbox(ws);

  let parsed: ParseOutcome = { kind: 'need-more' };
  if (buffer.length > 0) parsed = await parseHeader(buffer.bytes, store);

  if (parsed.kind === 'need-more') {
    parsed = await waitForHeader(ws, inbox, buffer, store, opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS);
  }

  if (parsed.kind !== 'ok') {
    const reason = parsed.kind === 'bad' ? parsed.reason : 'هدر کامل نشد';
    closeQuietly(ws, 1002, 'bad-request');
    return { ok: false, reason, usage };
  }

  const { request, client, codec, responsePrefix, consumed } = parsed;
  // بافر ممکن است بعد از پارس هم رشد کرده باشد؛ پس دنباله را از بافر *فعلی*
  // برمی‌داریم نه از snapshotِ زمان پارس.
  const firstPayload = buffer.bytes.subarray(consumed);

  // ── دیال مقصد
  const dialOpts: DialOptions = { ...(opts.dialDefaults ?? {}), ...client.dial, udp: request.udp === true };
  const dialer = opts.dialFn ?? dial;
  let dialed;
  try {
    dialed = await dialer(request.target, dialOpts);
  } catch (e) {
    closeQuietly(ws, 1011, 'dial-failed');
    const detail = e instanceof DialError ? `${e.message} — ${e.attempts.map((a) => `${a.via}: ${a.error}`).join(' | ')}` : String(e);
    return { ok: false, reason: detail, client, target: request.target, proto: request.proto, usage };
  }

  // ── رله
  await relay({
    ws,
    inbox,
    socket: dialed.socket as unknown as SocketLike,
    codec,
    preamble: dialed.preamble,
    responsePrefix,
    firstPayload: firstPayload.length ? firstPayload : undefined,
    counter: usage,
    idleMs: opts.idleMs,
  });

  return { ok: true, client, target: request.target, proto: request.proto, via: dialed.via, usage };
}

/**
 * منتظر فریم‌های بعدی می‌ماند تا هدر کامل شود.
 *
 * نکته‌ی کلیدی: بایت‌ها **همگام** به بافر اضافه می‌شوند و پارس جدا و async
 * انجام می‌شود. اگر برعکس بود (هر فریم داخل زنجیره‌ی async بافر شود) فریم‌هایی
 * که وقتی پارس در جریان است می‌رسند، پس از کامل شدن هدر دور ریخته می‌شدند —
 * یعنی چند بایت اول درخواست گم می‌شد. با این چیدمان، هر بایتی که قبل از تصمیم
 * رسیده باشد در بافر است و در `request.rest` به رله می‌رسد؛ بایت‌های بعد از
 * تصمیم هم در صف صندوق می‌مانند.
 */
function waitForHeader(
  ws: WsLike,
  inbox: WsInbox,
  buffer: HeaderBuffer,
  store: ClientStore,
  timeoutMs: number,
): Promise<ParseOutcome> {
  return new Promise<ParseOutcome>((resolve) => {
    let settled = false;
    let parsing = false;
    /** آیا از آخرین شروع پارس، بایت تازه‌ای رسیده؟ */
    let dirty = false;

    const finish = (outcome: ParseOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inbox.detach();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: 'need-more' }), timeoutMs);

    const pump = async (): Promise<void> => {
      if (parsing) {
        dirty = true;
        return;
      }
      parsing = true;
      try {
        for (;;) {
          if (settled) return;
          if (buffer.length > MAX_HEADER_BUFFER) {
            finish({ kind: 'bad', reason: 'هدر بیش از حد بزرگ' });
            return;
          }
          dirty = false;
          const out = await parseHeader(buffer.bytes, store);
          if (out.kind !== 'need-more') {
            finish(out);
            return;
          }
          // اگر در فاصله‌ی پارس بایت تازه‌ای آمده، دوباره امتحان می‌کنیم.
          if (!dirty) return;
        }
      } finally {
        parsing = false;
      }
    };

    inbox.attach((b: Uint8Array) => {
      if (settled) return;
      buffer.push(b);
      void pump();
    });

    ws.addEventListener('close', () => finish({ kind: 'bad', reason: 'اتصال قبل از هدر بسته شد' }));
    ws.addEventListener('error', () => finish({ kind: 'bad', reason: 'خطای WebSocket' }));
  });
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

function closeQuietly(ws: WsLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* از قبل بسته */
  }
}

/**
 * early-data را از هدر `Sec-WebSocket-Protocol` می‌خواند.
 *
 * کلاینت‌های Xray/sing-box با `?ed=2560` اولین بسته را base64url در همین هدر
 * می‌گذارند تا یک round-trip صرفه‌جویی شود. مقدار نامعتبر نادیده گرفته می‌شود
 * (بعضی کلاینت‌ها این هدر را برای چیز دیگری هم می‌فرستند).
 */
export function readEarlyData(headerValue: string | null): Uint8Array | null {
  if (!headerValue) return null;
  const v = headerValue.trim();
  if (!v || v.length > 8192) return null;
  try {
    const b = b64decode(v);
    return b.length ? b : null;
  } catch {
    return null;
  }
}

/** پیوند دو بافر — دوباره‌صادرشده تا لایه‌ی بالاتر لازم نباشد pipe را ایمپورت کند. */
export { join };
