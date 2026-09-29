/**
 * انتزاع AEAD برای بادی VMess — تا کد chunk از الگوریتم مستقل بماند.
 * AES-GCM بومی WebCrypto است؛ ChaCha20-Poly1305 در Workers نیست و
 * پیاده‌سازی خالص دارد (src/lib/chacha20poly1305.ts).
 */
import { ab } from '../lib/bytes';
import { chacha20poly1305Open, chacha20poly1305Seal } from '../lib/chacha20poly1305';

export interface Aead {
  /** بایت‌های اضافه‌ی هر chunk (tag). */
  readonly overhead: number;
  readonly nonceSize: number;
  seal(nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>;
  /** null = احراز اصالت شکست خورد. */
  open(nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array | null>;
}

/** AES-128/256-GCM با WebCrypto (کلید یک‌بار import می‌شود). */
export async function aesGcm(key: Uint8Array): Promise<Aead> {
  const ck = await crypto.subtle.importKey('raw', ab(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    overhead: 16,
    nonceSize: 12,
    async seal(nonce, plaintext, aad) {
      const p: SubtleCryptoEncryptAlgorithm = { name: 'AES-GCM', iv: ab(nonce), tagLength: 128 };
      if (aad) p.additionalData = ab(aad);
      return new Uint8Array(await crypto.subtle.encrypt(p, ck, ab(plaintext)));
    },
    async open(nonce, ciphertext, aad) {
      const p: SubtleCryptoEncryptAlgorithm = { name: 'AES-GCM', iv: ab(nonce), tagLength: 128 };
      if (aad) p.additionalData = ab(aad);
      try {
        return new Uint8Array(await crypto.subtle.decrypt(p, ck, ab(ciphertext)));
      } catch {
        return null;
      }
    },
  };
}

/** ChaCha20-Poly1305 خالص (WebCrypto در Workers ندارد). */
export function chachaPoly(key: Uint8Array): Aead {
  return {
    overhead: 16,
    nonceSize: 12,
    async seal(nonce, plaintext, aad) {
      return chacha20poly1305Seal(key, nonce, plaintext, aad);
    },
    async open(nonce, ciphertext, aad) {
      return chacha20poly1305Open(key, nonce, ciphertext, aad);
    },
  };
}

/** بدون رمز — برای security=none که فقط chunk-framing دارد. */
export const noopAead: Aead = {
  overhead: 0,
  nonceSize: 0,
  async seal(_n, p) {
    return p;
  },
  async open(_n, c) {
    return c;
  },
};
