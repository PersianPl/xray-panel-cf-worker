/**
 * TOTP (RFC 6238) با WebCrypto — بدون وابستگی بیرونی.
 *
 * چرا SHA-1: الگوریتم استاندارد Google Authenticator و همه‌ی اپ‌های
 * Authenticator همین است؛ HMAC-SHA1 در WebCrypto کلادفلر پشتیبانی می‌شود.
 *
 * جریان در پنل:
 *   ۱. «راه‌اندازی» → رمز جدید Base32 ساخته می‌شود (فعال نیست هنوز) + QR
 *   ۲. ادمین با اپ اسکن می‌کند و کد ۳۰ ثانیه‌ای را برای تأیید می‌فرستد
 *   ۳. تأیید شد → `twofa_enabled=1`؛ از این پس ورود بدون کد ممکن نیست
 *   ۴. «خاموش‌کردن» هم کد فعال می‌خواهد (کسی که پنل را باز دارد نتواند
 *      بدون اپِ ادمین قفل را بردارد)
 */
const enc = new TextEncoder();
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648، بدون padding) — رمزها همین‌طور در تنظیمات ذخیره می‌شوند. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = (s ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, message as BufferSource));
}

/** HOTP (RFC 4226) — شمارنده‌ی ۸ بایتی، برش دینامیک، کد N رقمی. */
export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = await hmacSha1(secret, msg);
  // برش دینامیک RFC 4226: آفست از آخرین بایت (SHA-1 = ۲۰ بایت، ایندکس ۱۹)
  const off = mac[19]! & 0x0f;
  const bin =
    ((mac[off]! & 0x7f) << 24) |
    ((mac[off + 1]! & 0xff) << 16) |
    ((mac[off + 2]! & 0xff) << 8) |
    (mac[off + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** طول هر گام TOTP (استاندارد همه‌ی اپ‌ها). */
export const TOTP_STEP = 30;

/** کد TOTP در زمان مشخص (ثانیه از epoch). */
export async function totp(
  secret: Uint8Array | string,
  atSec = Math.floor(Date.now() / 1000),
  digits = 6,
): Promise<string> {
  const s = typeof secret === 'string' ? base32Decode(secret) : secret;
  return hotp(s, Math.floor(atSec / TOTP_STEP), digits);
}

function timingSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * تأیید کد با پنجره‌ی ±۱ گام (تحمل ۳۰ ثانیه انحراف ساعت بین سرور و اپ).
 * کد باید دقیقاً ۶ رقم باشد.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  opts: { at?: number; window?: number } = {},
): Promise<boolean> {
  const clean = (code ?? '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const s = base32Decode(secret);
  if (s.length < 10) return false; // رمز خیلی کوتاه = پیکربندی خراب
  const counter = Math.floor((opts.at ?? Math.floor(Date.now() / 1000)) / TOTP_STEP);
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    if (timingSafe(await hotp(s, counter + d), clean)) return true;
  }
  return false;
}

/** رمز جدید: ۲۰ بایت تصادفی → Base32 (۱۶۰ بیت، توصیه‌ی RFC 4226). */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** لینک استانداردی که اپ‌های Authenticator با دوربین یا دستی می‌خوانند. */
export function otpauthUrl(secret: string, account: string, issuer = 'PersianPl-Panel'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
}