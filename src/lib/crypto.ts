/**
 * توابع رمزنگاری با WebCrypto — بدون وابستگی بیرونی.
 */

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/** مقایسه‌ی زمان‌ثابت برای توکن‌ها و هش رمز. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PBKDF2-SHA256 با ۲۱۰٬۰۰۰ تکرار (توصیه‌ی OWASP 2023 برای این الگوریتم). */
const PBKDF2_ITER = 210_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  const saltHex = parts[2]!;
  const expect = parts[3]!;
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const bits = await derive(password, fromHex(saltHex), iter);
  return timingSafeEqual(toHex(bits), expect);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** HMAC-SHA256 برای امضای کانفیگی که به نودها می‌رود. */
export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export async function hmacVerify(secret: string, payload: string, sig: string): Promise<boolean> {
  return timingSafeEqual(await hmacSign(secret, payload), sig);
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** رشته‌ی کوتاه امن برای نام کاربر و توکن ساب (بدون کاراکتر مبهم). */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomId(len = 10): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return s;
}

export function uuidv4(): string {
  return crypto.randomUUID();
}

/** UUID را به ۱۶ بایت تبدیل می‌کند (برای مقایسه با هدر VLESS/VMess). */
export function uuidToBytes(uuid: string): Uint8Array {
  return fromHex(uuid.replace(/-/g, ''));
}

export function bytesToUuid(b: Uint8Array): string {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function b64encode(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * base64url بدون padding — همان «websafe-base64» که SIP002 برای بخش userinfo
 * لینک `ss://` می‌خواهد.
 *
 * چرا لازم است: base64 استاندارد `+` و `/` تولید می‌کند و `/` در URI بخش
 * authority را می‌بندد. یعنی یک رمز بی‌گناه مثل `pa?s` یا هر رمزی که خروجی‌اش
 * `/` داشته باشد، لینک را به‌کل خراب می‌کند — و چون فقط برای بعضی رمزها پیش
 * می‌آید، بی‌سر‌و‌صدا خراب می‌کند.
 */
export function b64urlencode(bytes: Uint8Array | string): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
