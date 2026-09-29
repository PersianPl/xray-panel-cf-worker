/**
 * X25519 (RFC 7748) — تنها بخشی از رمزنگاری که WebCrypto کلادفلر ارائه نمی‌دهد
 * و برای ساخت هویت WARP لازم است.
 *
 * چرا کتابخانه: پیاده‌سازی دستیِ نردبان مونتگومری با BigInt در محیط Worker با
 * بردارهای آزمون RFC جور درنمی‌آمد (نتایج وابسته به محیط اجرا)؛ به‌جای ریسک،
 * `@noble/curves` — استاندارد صنعتی و تست‌شده با همان بردارها — استفاده می‌شود.
 * فقط سه تابعِ لازم اینجا پوشانده شده تا بقیه‌ی کدبیس نداند زیرِ آن چه است.
 */
import { x25519 } from '@noble/curves/ed25519.js';

/** کلید خصوصی: ۳۲ بایت تصادفی (کلمپ RFC در هنگام استفاده داخل کتابخانه انجام می‌شود). */
export function generatePrivateKey(): Uint8Array {
  return x25519.utils.randomSecretKey();
}

/** کلید عمومی متناظر با کلید خصوصی (ضرب در نقطه‌ی پایه). */
export function publicKeyFrom(priv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(priv);
}

/** ضرب اسکالر در نقطه‌ی دلخواه (برای تست و مشتق‌سازی). */
export function scalarMult(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(scalar, u);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
