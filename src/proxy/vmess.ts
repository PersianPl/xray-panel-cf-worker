/**
 * VMess AEAD — سرور کامل: پارس درخواست، هدر پاسخ، و فریم‌بندی بادی.
 * مبنا: v2ray-core proxy/vmess/{aead,encoding} و common/crypto — نسخه‌ی داخل _audit/.
 *
 * درخواست روی سیم:
 *   authID(16) | AEAD-len(2+16) | connNonce(8) | AEAD-header(len+16)
 *   cmdKey = MD5(uuid16 || "c48619fe-8f02-49e0-b9e9-edf763e17e21")
 *   authID = AES-ECB( KDF16(cmdKey,"AES Auth ID Encryption"), time(8BE)|rand(4)|CRC32(۱۲ بایت اول) )
 *   هر دو بلوک AEAD: AES-128-GCM با AD=authID و
 *     کلید KDF16(cmdKey, salt, authID, connNonce) · nonce KDF(cmdKey, saltIV, authID, connNonce)[:12]
 *
 * هدر رمزگشایی‌شده:
 *   ver(1)=1 | reqIV(16) | reqKey(16) | respV(1) | opt(1) | (padLen<<4)|sec(1) | rsv(1) | cmd(1)
 *   | port(2BE)+atype(1)+addr | padding(padLen) | FNV1a32(همه‌ی بایت‌های قبل، 4BE)
 *   opt: 0x01 chunkStream · 0x02 connReuse · 0x04 chunkMasking · 0x08 globalPadding · 0x10 authLen
 *   sec: 3=AES-128-GCM · 4=ChaCha20-Poly1305 · 5=none   (1=legacy نیاز به AES-CFB جریانی دارد
 *        و پشتیبانی نمی‌شود؛ 6=zero را کلاینت خودش به none تبدیل می‌کند و سرور رسمی هم ردش می‌کند)
 *   cmd: 1=TCP · 2=UDP · 3=Mux(v1.mux.cool). فقط UDP انتقالِ packet است.
 *
 * پاسخ: respKey=SHA256(reqKey)[:16] · respIV=SHA256(reqIV)[:16] — بدون لایه‌ی CFB
 *   (CFB فقط در مسیر legacy است) — AEAD-len(2+16, "AEAD Resp Header Len Key/IV", AD=nil)
 *   + AEAD-payload(4+16, "AEAD Resp Header Key/IV", AD=nil) روی {respV, opt=0, cmd=0, cmdLen=0}
 *
 * فریم‌بندی بادی سه حالت دارد (دقیقاً مثل DecodeRequestBody):
 *   raw          : بدون گزینه‌ی chunkStream — بایت خام، بی هیچ سرآیندی
 *   plain-stream : security=none با انتقال stream → ChunkStreamReader: size(2) | payload، size=0 پایان
 *   aead         : بقیه → AuthenticationReader: size(2 یا 2+16) | AEAD(payload) | padding
 *
 * در حالت aead ترتیب مصرف جریان SHAKE در هر دو جهت یکی است: **اول NextPaddingLen، بعد size**
 *   (auth.go seal(): padding سپس Encode · readSize(): padding سپس Decode).
 *   پدینگ در انتهای chunk و بیرون AEAD است. chunk خالی (size == overhead+padding) پایانِ استریم.
 */
import { ByteWriter, concat, crc32, readU16be, readU32be, u32be, u64be } from '../lib/bytes';
import { aes128 } from '../lib/aes';
import { md5 } from '../lib/md5';
import { sha256, hmacWith } from '../lib/sha256';
import { ShakeMask, ChunkNonce } from '../lib/vmess-mask';
import { aesGcm, chachaPoly, noopAead, type Aead } from './aead';
import { parseTarget, writeTarget } from './target';
import type { Target } from './types';

const enc = new TextEncoder();

export const OPT_CHUNK_STREAM = 0x01;
export const OPT_CONNECTION_REUSE = 0x02;
export const OPT_CHUNK_MASKING = 0x04;
export const OPT_GLOBAL_PADDING = 0x08;
export const OPT_AUTHENTICATED_LENGTH = 0x10;

export const SEC_LEGACY = 1;
export const SEC_AUTO = 2;
export const SEC_AES128_GCM = 3;
export const SEC_CHACHA20_POLY1305 = 4;
export const SEC_NONE = 5;
export const SEC_ZERO = 6;

export const CMD_TCP = 1;
export const CMD_UDP = 2;
export const CMD_MUX = 3;

const S_AUTHID_KEY = 'AES Auth ID Encryption';
const S_HDR_LEN_KEY = 'VMess Header AEAD Key_Length';
const S_HDR_LEN_IV = 'VMess Header AEAD Nonce_Length';
const S_HDR_KEY = 'VMess Header AEAD Key';
const S_HDR_IV = 'VMess Header AEAD Nonce';
const S_RESP_LEN_KEY = 'AEAD Resp Header Len Key';
const S_RESP_LEN_IV = 'AEAD Resp Header Len IV';
const S_RESP_KEY = 'AEAD Resp Header Key';
const S_RESP_IV = 'AEAD Resp Header IV';
const S_AUTH_LEN = 'auth_len';

/** سقف chunk در v2ray (buf.Size) — برای انتخاب اندازه‌ی نوشتن. */
export const BUF_SIZE = 2048;

/**
 * KDF زنجیره‌ای VMess — معادل دقیق aead.KDF:
 * ریشه hmac.New(sha256, "VMess AEAD KDF") است و هر عضو path یک HMAC تازه
 * با کلیدِ خودش روی «تابع هشِ والد» می‌سازد؛ در پایان key به‌عنوان پیام نوشته می‌شود.
 */
export function vmessKDF(key: Uint8Array, ...path: Array<string | Uint8Array>): Uint8Array {
  let hash: (m: Uint8Array) => Uint8Array = sha256;
  let level: Uint8Array = enc.encode('VMess AEAD KDF');
  for (const p of path) {
    const parentHash = hash;
    const parentKey = level;
    hash = (m: Uint8Array) => hmacWith(parentHash, parentKey, m);
    level = typeof p === 'string' ? enc.encode(p) : p;
  }
  return hmacWith(hash, level, key);
}

export function vmessKDF16(key: Uint8Array, ...path: Array<string | Uint8Array>): Uint8Array {
  return vmessKDF(key, ...path).subarray(0, 16);
}

const CMD_KEY_MAGIC = enc.encode('c48619fe-8f02-49e0-b9e9-edf763e17e21');

/** cmdKey = MD5(uuidBytes || magic) — پایه‌ی همه‌ی کلیدهای VMess. */
export function vmessCmdKey(uuidBytes: Uint8Array): Uint8Array {
  return md5(concat(uuidBytes, CMD_KEY_MAGIC));
}

/** کلید ثابت رمزگذاری authID برای یک کاربر؛ یک‌بار حساب و کش می‌شود. */
export function authIdKey(cmdKey: Uint8Array): Uint8Array {
  return vmessKDF16(cmdKey, S_AUTHID_KEY);
}

/** FNV-1a 32 بیتی — checksum هدر درخواست. */
export function fnv1a32(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * بازکردن authID با کلید یک کاربر — معادل AuthIDDecoderHolder.Match برای یک کاربر:
 * CRC32 روی ۱۲ بایت اول، t ≥ 0، و |t − now| ≤ 120.
 * (تشخیص replay در لایه‌ی بالاتر با KV/حافظه‌ی isolate انجام می‌شود.)
 */
export function tryAuthId(authIdKey16: Uint8Array, authId: Uint8Array, nowSec: number, windowSec = 120): boolean {
  if (authId.length !== 16) return false;
  const buf = authId.slice(0);
  aes128(authIdKey16).decryptBlock(buf, 0);
  if (crc32(buf.subarray(0, 12)) !== readU32be(buf, 12)) return false;
  // t یک int64 BE است؛ چهار بایت بالا تا سال ۲۱۰۶ صفر می‌ماند و منفی هم رد می‌شود.
  if (readU32be(buf, 0) !== 0) return false;
  return Math.abs(readU32be(buf, 4) - nowSec) <= windowSec;
}

/** ساخت authID — برای تست‌ها و برای زنجیره‌کردن به یک سرور VMess دیگر. */
export function createAuthId(cmdKey: Uint8Array, timeSec: number, rand4?: Uint8Array): Uint8Array {
  const buf = new Uint8Array(16);
  buf.set(u64be(timeSec), 0);
  buf.set(rand4 ?? crypto.getRandomValues(new Uint8Array(4)), 8);
  const c = crc32(buf.subarray(0, 12));
  buf[12] = (c >>> 24) & 0xff;
  buf[13] = (c >>> 16) & 0xff;
  buf[14] = (c >>> 8) & 0xff;
  buf[15] = c & 0xff;
  aes128(authIdKey(cmdKey)).encryptBlock(buf, 0);
  return buf;
}

export interface VmessHeader {
  version: number;
  reqIV: Uint8Array;
  reqKey: Uint8Array;
  respV: number;
  option: number;
  security: number;
  command: number;
  target: Target;
  /** انتقالِ packet است (فقط UDP) — روی فریم‌بندی security=none اثر دارد. */
  packet: boolean;
  mux: boolean;
}

/** کمترین بایت لازم برای فهمیدن طول کل هدر: authID + AEAD-len + connNonce. */
export const VMESS_MIN_PREFIX = 16 + 18 + 8;

export type VmessOpenResult =
  | { kind: 'need-more' }
  | { kind: 'bad'; reason: string }
  | { kind: 'ok'; header: VmessHeader; consumed: number };

/**
 * بازکردن هدر AEAD درخواست با cmdKeyِ کاربرِ تطبیق‌یافته.
 * consumed = بایت‌های مصرف‌شده؛ بقیه‌ی بافر، آغاز بادی است.
 */
export async function openVmessRequest(b: Uint8Array, cmdKey: Uint8Array): Promise<VmessOpenResult> {
  if (b.length < VMESS_MIN_PREFIX) return { kind: 'need-more' };
  const authId = b.subarray(0, 16);
  const sealedLen = b.subarray(16, 34);
  const nonce = b.subarray(34, 42);

  const lenAead = await aesGcm(vmessKDF16(cmdKey, S_HDR_LEN_KEY, authId, nonce));
  const lenIv = vmessKDF(cmdKey, S_HDR_LEN_IV, authId, nonce).subarray(0, 12);
  const lenPlain = await lenAead.open(lenIv, sealedLen, authId);
  if (!lenPlain || lenPlain.length !== 2) return { kind: 'bad', reason: 'length-aead' };
  const hdrLen = readU16be(lenPlain, 0);
  // ۳۸ بایت ثابت + حداکثر آدرس ۲۵۸ + پدینگ ۱۵ + ۴ چک‌سام؛ سخت‌گیری برای جلوگیری از تخصیص بی‌جا.
  if (hdrLen < 38 + 4 || hdrLen > 512) return { kind: 'bad', reason: 'length-range' };

  const total = 42 + hdrLen + 16;
  if (b.length < total) return { kind: 'need-more' };

  const hdrAead = await aesGcm(vmessKDF16(cmdKey, S_HDR_KEY, authId, nonce));
  const hdrIv = vmessKDF(cmdKey, S_HDR_IV, authId, nonce).subarray(0, 12);
  const plain = await hdrAead.open(hdrIv, b.subarray(42, total), authId);
  if (!plain) return { kind: 'bad', reason: 'header-aead' };

  const header = parseVmessHeader(plain);
  if (!header) return { kind: 'bad', reason: 'header-parse' };
  return { kind: 'ok', header, consumed: total };
}

/** پارس هدر رمزگشایی‌شده — با بررسی FNV و طول پدینگ. */
export function parseVmessHeader(p: Uint8Array): VmessHeader | null {
  if (p.length < 38 + 4) return null;
  if (p[0] !== 1) return null;
  const reqIV = p.subarray(1, 17);
  const reqKey = p.subarray(17, 33);
  const respV = p[33]!;
  const option = p[34]!;
  const padLen = p[35]! >> 4;
  const security = p[35]! & 0x0f;
  const command = p[37]!;

  let target: Target;
  let off: number;
  if (command === CMD_MUX) {
    target = { host: 'v1.mux.cool', port: 0 };
    off = 38;
  } else if (command === CMD_TCP || command === CMD_UDP) {
    const t = parseTarget(p, 38);
    if (!t) return null;
    target = t.target;
    off = t.next;
  } else {
    return null;
  }

  if (off + padLen + 4 > p.length) return null;
  if (fnv1a32(p.subarray(0, off + padLen)) !== readU32be(p, off + padLen)) return null;
  if (security !== SEC_AES128_GCM && security !== SEC_CHACHA20_POLY1305 && security !== SEC_NONE) return null;

  return {
    version: 1,
    reqIV,
    reqKey,
    respV,
    option,
    security,
    command,
    target,
    packet: command === CMD_UDP,
    mux: command === CMD_MUX,
  };
}

/** کلید ChaCha20 وِمِس: MD5(k) || MD5(MD5(k)). */
export function chachaKeyFrom(k: Uint8Array): Uint8Array {
  const a = md5(k);
  return concat(a, md5(a));
}

async function aeadFor(security: number, key: Uint8Array): Promise<Aead> {
  if (security === SEC_AES128_GCM) return aesGcm(key);
  if (security === SEC_CHACHA20_POLY1305) return chachaPoly(chachaKeyFrom(key));
  return noopAead;
}

/** حالت فریم‌بندی یک جهت از بادی. */
export type FrameMode = 'raw' | 'plain-stream' | 'aead';

/** یک جهت از بادی VMess: AEAD، ماسک SHAKE، شمارنده‌ی nonce و پارامترهای طول. */
export interface BodyCodec {
  mode: FrameMode;
  aead: Aead;
  mask: ShakeMask | null;
  nonce: ChunkNonce;
  padding: boolean;
  /** طول با AEAD مستقل احراز می‌شود (گزینه‌ی authenticatedLength در Xray). */
  lenAead: Aead | null;
  lenNonce: ChunkNonce | null;
  /** بایت‌های سرآیند طول: ۲ یا ۲+overhead. */
  sizeBytes: number;
  /**
   * سرآیندِ خوانده‌شده‌ای که بدنه‌اش هنوز کامل نرسیده — معادل hasSize/size/paddingLen
   * در AuthenticationReader. بدون این، تلاش دوم برای خواندن همان chunk جریان SHAKE و
   * شمارنده‌ی nonceِ طول را دوباره پیش می‌برد و همه‌چیز از هم‌گامی خارج می‌شود.
   */
  pendingHead: { size: number; padding: number } | null;
}

async function makeCodec(
  header: VmessHeader,
  key: Uint8Array,
  iv: Uint8Array,
  /** کلید/IV مبنای auth_len — در هر دو جهت از requestBodyKey/IV می‌آید. */
  reqKey: Uint8Array,
  reqIV: Uint8Array,
): Promise<BodyCodec> {
  const { option, security, packet } = header;
  const chunked = (option & OPT_CHUNK_STREAM) !== 0;
  const masking = (option & OPT_CHUNK_MASKING) !== 0;
  const mask = masking ? new ShakeMask(iv) : null;

  let mode: FrameMode;
  if (!chunked) mode = 'raw';
  else if (security === SEC_NONE && !packet) mode = 'plain-stream';
  else mode = 'aead';

  const aead = mode === 'aead' ? await aeadFor(security, key) : noopAead;
  const codec: BodyCodec = {
    mode,
    aead,
    mask,
    nonce: new ChunkNonce(iv, aead.nonceSize),
    // پدینگ فقط در AuthenticationReader/Writer اعمال می‌شود، آن هم وقتی ماسک روشن باشد.
    padding: mode === 'aead' && masking && (option & OPT_GLOBAL_PADDING) !== 0,
    lenAead: null,
    lenNonce: null,
    sizeBytes: 2,
    pendingHead: null,
  };

  if (mode === 'aead' && (option & OPT_AUTHENTICATED_LENGTH) !== 0 && security !== SEC_NONE) {
    codec.lenAead = await aeadFor(security, vmessKDF16(reqKey, S_AUTH_LEN));
    codec.lenNonce = new ChunkNonce(reqIV, codec.lenAead.nonceSize);
    codec.sizeBytes = 2 + codec.lenAead.overhead;
  }
  return codec;
}

export interface VmessSession {
  header: VmessHeader;
  /** کدک جهت کلاینت→سرور. */
  request: BodyCodec;
  /** کدک جهت سرور→کلاینت. */
  response: BodyCodec;
  respKey: Uint8Array;
  respIV: Uint8Array;
}

/** ساخت وضعیت کامل نشست از هدرِ پارس‌شده. */
export async function newVmessSession(header: VmessHeader): Promise<VmessSession> {
  const respKey = sha256(header.reqKey).subarray(0, 16);
  const respIV = sha256(header.reqIV).subarray(0, 16);
  const request = await makeCodec(header, header.reqKey, header.reqIV, header.reqKey, header.reqIV);
  const response = await makeCodec(header, respKey, respIV, header.reqKey, header.reqIV);
  return { header, request, response, respKey, respIV };
}

/** هدر پاسخ AEAD؛ بعد از آن بادی با فریم‌بندی معمول می‌آید. */
export async function buildVmessResponseHeader(s: VmessSession): Promise<Uint8Array> {
  // {respV, option=0, command=0, commandLen=0} — بدون فرمان داینامیک‌پورت.
  const plain = new Uint8Array([s.header.respV, 0, 0, 0]);

  const lenAead = await aesGcm(vmessKDF16(s.respKey, S_RESP_LEN_KEY));
  const lenIv = vmessKDF(s.respIV, S_RESP_LEN_IV).subarray(0, 12);
  const sealedLen = await lenAead.seal(lenIv, new Uint8Array([0, plain.length]));

  const payAead = await aesGcm(vmessKDF16(s.respKey, S_RESP_KEY));
  const payIv = vmessKDF(s.respIV, S_RESP_IV).subarray(0, 12);
  const sealedPay = await payAead.seal(payIv, plain);

  return concat(sealedLen, sealedPay);
}

/**
 * وارونِ openVmessRequest — هدر درخواست را می‌سازد و مهر می‌کند.
 * لازم است برای زنجیره‌کردن به یک سرور VMess بالادست، و تست‌های رفت‌وبرگشت.
 */
export async function sealVmessRequest(
  cmdKey: Uint8Array,
  plainHeader: Uint8Array,
  opts: { timeSec?: number; authId?: Uint8Array; nonce?: Uint8Array } = {},
): Promise<Uint8Array> {
  const authId = opts.authId ?? createAuthId(cmdKey, opts.timeSec ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(8));

  const lenAead = await aesGcm(vmessKDF16(cmdKey, S_HDR_LEN_KEY, authId, nonce));
  const lenIv = vmessKDF(cmdKey, S_HDR_LEN_IV, authId, nonce).subarray(0, 12);
  const sealedLen = await lenAead.seal(lenIv, new Uint8Array([(plainHeader.length >> 8) & 0xff, plainHeader.length & 0xff]), authId);

  const hdrAead = await aesGcm(vmessKDF16(cmdKey, S_HDR_KEY, authId, nonce));
  const hdrIv = vmessKDF(cmdKey, S_HDR_IV, authId, nonce).subarray(0, 12);
  const sealedHdr = await hdrAead.seal(hdrIv, plainHeader, authId);

  return concat(authId, sealedLen, nonce, sealedHdr);
}

/** بایت‌های خام هدر درخواست (بدون AEAD) — با پدینگ و FNV. */
export function buildVmessHeaderPlain(h: {
  reqIV: Uint8Array;
  reqKey: Uint8Array;
  respV: number;
  option: number;
  security: number;
  command: number;
  target: Target;
  padLen?: number;
}): Uint8Array {
  const padLen = h.padLen ?? 0;
  const w = new ByteWriter();
  w.byte(1);
  w.write(h.reqIV);
  w.write(h.reqKey);
  w.byte(h.respV);
  w.byte(h.option);
  w.byte(((padLen & 0x0f) << 4) | (h.security & 0x0f));
  w.byte(0);
  w.byte(h.command);
  if (h.command !== CMD_MUX) writeTarget(w, h.target.host, h.target.port);
  if (padLen > 0) w.write(crypto.getRandomValues(new Uint8Array(padLen)));
  const body = w.toBytes();
  return concat(body, u32be(fnv1a32(body)));
}

/** بازکردن هدر پاسخ AEAD — برای مسیر زنجیره و تست. */
export async function openVmessResponseHeader(s: VmessSession, b: Uint8Array): Promise<Uint8Array | null> {
  if (b.length < 18) return null;
  const lenAead = await aesGcm(vmessKDF16(s.respKey, S_RESP_LEN_KEY));
  const lenIv = vmessKDF(s.respIV, S_RESP_LEN_IV).subarray(0, 12);
  const lenPlain = await lenAead.open(lenIv, b.subarray(0, 18));
  if (!lenPlain || lenPlain.length !== 2) return null;
  const n = readU16be(lenPlain, 0);
  if (b.length < 18 + n + 16) return null;
  const payAead = await aesGcm(vmessKDF16(s.respKey, S_RESP_KEY));
  const payIv = vmessKDF(s.respIV, S_RESP_IV).subarray(0, 12);
  return payAead.open(payIv, b.subarray(18, 18 + n + 16));
}

export type ChunkResult =
  | { kind: 'need-more' }
  | { kind: 'bad'; reason: string }
  | { kind: 'eof'; consumed: number }
  | { kind: 'data'; payload: Uint8Array; consumed: number };

/**
 * سرآیند طول را می‌خواند. ترتیب مصرف SHAKE عیناً مثل readSize/seal رسمی است:
 * اول NextPaddingLen و بعد ماسکِ طول. سرآیندِ کشیده‌شده در pendingHead می‌ماند تا
 * اگر بدنه ناقص بود، در فراخوانی بعدی جریان دوباره پیش نرود.
 */
async function readFrameHead(
  c: BodyCodec,
  b: Uint8Array,
  off: number,
): Promise<{ size: number; padding: number; next: number } | 'need-more' | 'bad'> {
  if (c.pendingHead) return { ...c.pendingHead, next: off + c.sizeBytes };
  if (off + c.sizeBytes > b.length) return 'need-more';
  const padding = c.padding ? c.mask!.nextPaddingLen() : 0;

  let size: number;
  if (c.lenAead) {
    const plain = await c.lenAead.open(c.lenNonce!.next(), b.subarray(off, off + c.sizeBytes));
    if (!plain || plain.length !== 2) return 'bad';
    // AEADChunkSizeParser.Decode: مقدارِ رمزشده + overhead
    size = readU16be(plain, 0) + c.aead.overhead;
  } else {
    const raw = b.slice(off, off + 2);
    if (c.mask) c.mask.applySize(raw, 0);
    size = readU16be(raw, 0);
  }

  c.pendingHead = { size, padding };
  return { size, padding, next: off + c.sizeBytes };
}

/**
 * یک chunk را از بافر می‌خواند. consumed نسبت به off است.
 * در حالت raw همه‌ی بایت‌های موجود یک‌جا برگردانده می‌شوند (پایانی وجود ندارد).
 */
export async function readChunk(c: BodyCodec, b: Uint8Array, off = 0): Promise<ChunkResult> {
  if (c.mode === 'raw') {
    if (off >= b.length) return { kind: 'need-more' };
    return { kind: 'data', payload: b.subarray(off), consumed: b.length - off };
  }

  const head = await readFrameHead(c, b, off);
  if (head === 'need-more') return { kind: 'need-more' };
  if (head === 'bad') return { kind: 'bad', reason: 'auth-len' };
  const { size, padding, next } = head;

  if (c.mode === 'plain-stream') {
    // ChunkStreamReader: طول = دقیقاً طول payload؛ صفر یعنی پایان.
    if (size === 0) {
      c.pendingHead = null;
      return { kind: 'eof', consumed: next - off };
    }
    if (next + size > b.length) return { kind: 'need-more' };
    c.pendingHead = null;
    return { kind: 'data', payload: b.subarray(next, next + size), consumed: next + size - off };
  }

  // AuthenticationReader: size شامل overhead و padding است.
  if (size === c.aead.overhead + padding) {
    c.pendingHead = null;
    return { kind: 'eof', consumed: next - off };
  }
  if (size < c.aead.overhead + padding) return { kind: 'bad', reason: 'size-underflow' };
  if (next + size > b.length) return { kind: 'need-more' };

  const sealed = b.subarray(next, next + size - padding);
  const payload = c.aead.overhead === 0 ? sealed : await c.aead.open(c.nonce.next(), sealed);
  if (!payload) return { kind: 'bad', reason: 'body-aead' };
  c.pendingHead = null;
  return { kind: 'data', payload, consumed: next + size - off };
}

/** بیشترین بایت payload در یک chunk — همان محدودیتِ نویسنده‌ی رسمی (buf.Size). */
export function maxPayload(c: BodyCodec): number {
  if (c.mode === 'raw') return 0x7fffffff;
  if (c.mode === 'plain-stream') return 8192;
  return BUF_SIZE - c.aead.overhead - c.sizeBytes - (c.padding ? 64 : 0);
}

/** یک chunk خروجی می‌سازد. payload باید ≤ maxPayload باشد. */
export async function writeChunk(c: BodyCodec, payload: Uint8Array): Promise<Uint8Array> {
  if (c.mode === 'raw') return payload;

  if (c.mode === 'plain-stream') {
    const len = new Uint8Array([(payload.length >> 8) & 0xff, payload.length & 0xff]);
    if (c.mask) c.mask.applySize(len, 0);
    return payload.length === 0 ? len : concat(len, payload);
  }

  const sealed = c.aead.overhead === 0 ? payload : await c.aead.seal(c.nonce.next(), payload);
  // ترتیب seal رسمی: اول پدینگ از SHAKE کشیده می‌شود، بعد طول رمز/ماسک می‌شود.
  const padding = c.padding ? c.mask!.nextPaddingLen() : 0;
  const size = sealed.length + padding;

  let head: Uint8Array;
  if (c.lenAead) {
    const inner = size - c.aead.overhead;
    head = await c.lenAead.seal(c.lenNonce!.next(), new Uint8Array([(inner >> 8) & 0xff, inner & 0xff]));
  } else {
    head = new Uint8Array([(size >> 8) & 0xff, size & 0xff]);
    if (c.mask) c.mask.applySize(head, 0);
  }

  if (padding === 0) return concat(head, sealed);
  return concat(head, sealed, crypto.getRandomValues(new Uint8Array(padding)));
}

/**
 * chunk پایانی — کلاینت با دیدنش استریم را می‌بندد.
 * در حالت raw چیزی برای فرستادن نیست (بسته‌شدن سوکت خودش سیگنال است).
 */
export async function writeEndChunk(c: BodyCodec): Promise<Uint8Array> {
  if (c.mode === 'raw') return new Uint8Array(0);
  return writeChunk(c, new Uint8Array(0));
}

/** همه‌ی payload را به chunkهای مجاز می‌شکند و به هم می‌چسباند. */
export async function writeAll(c: BodyCodec, payload: Uint8Array): Promise<Uint8Array> {
  const cap = maxPayload(c);
  if (payload.length <= cap) return writeChunk(c, payload);
  const parts: Uint8Array[] = [];
  for (let o = 0; o < payload.length; o += cap) {
    parts.push(await writeChunk(c, payload.subarray(o, Math.min(o + cap, payload.length))));
  }
  return concat(...parts);
}

/**
 * بافر تجمعی روی یک جهت — بایت‌های ناقصِ WebSocket را نگه می‌دارد و
 * هر بار که chunk کامل شد آن را بیرون می‌دهد.
 */
export class ChunkStream {
  private buf: Uint8Array = new Uint8Array(0);
  private ended = false;

  constructor(private readonly codec: BodyCodec) {}

  get done(): boolean {
    return this.ended;
  }

  push(b: Uint8Array): void {
    this.buf = this.buf.length === 0 ? b : concat(this.buf, b);
  }

  /** همه‌ی chunkهای کاملِ موجود؛ null یعنی داده‌ی خراب. */
  async drain(): Promise<Uint8Array[] | null> {
    const out: Uint8Array[] = [];
    while (!this.ended && this.buf.length > 0) {
      const r = await readChunk(this.codec, this.buf, 0);
      if (r.kind === 'need-more') break;
      if (r.kind === 'bad') return null;
      if (r.kind === 'eof') {
        this.ended = true;
        this.buf = new Uint8Array(0);
        break;
      }
      // subarray به بافر قبلی اشاره می‌کند؛ چون بافر را جا‌به‌جا می‌کنیم باید کپی بگیریم.
      out.push(r.payload.slice(0));
      this.buf = this.buf.subarray(r.consumed);
    }
    return out;
  }
}
