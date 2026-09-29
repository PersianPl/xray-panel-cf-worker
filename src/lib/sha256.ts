/**
 * SHA-256 خالص و همگام (sync) — WebCrypto فقط async است و KDF زنجیره‌ای VMess
 * برای هر مقدار ۱۶ فراخوانی هش می‌خواهد؛ همگام بودن کد را ساده و سریع می‌کند.
 * صحت در tests/hash.spec.ts مستقیماً با crypto.subtle مقایسه می‌شود.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** بردار اولیه‌ی SHA-224 (FIPS 180-4 §5.3.2) — بقیه‌ی الگوریتم عیناً SHA-256 است. */
const H0_224 = new Uint32Array([
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

export function sha256(data: Uint8Array): Uint8Array {
  return sha2(data, H0, 32);
}

/**
 * SHA-224 — لازمِ Trojan (`hex(SHA224(password))`).
 * WebCrypto در Workers فقط SHA-1/256/384/512 دارد، پس همین‌جا ساخته می‌شود.
 */
export function sha224(data: Uint8Array): Uint8Array {
  return sha2(data, H0_224, 28);
}

function sha2(data: Uint8Array, iv: Uint32Array, outLen: number): Uint8Array {
  const h = new Uint32Array(iv);
  const bitLen = data.length * 8;
  const total = (((data.length + 9) / 64) | 0) * 64 + ((data.length + 9) % 64 === 0 ? 0 : 64);
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296) >>> 0);
  dv.setUint32(total - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return outLen === 32 ? out : out.subarray(0, outLen);
}

/** HMAC-SHA256 همگام (برای امضای درون‌مسیر و پایه‌ی KDF). */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmacWith(sha256, key, msg);
}

/** بلوک‌سایز همه‌ی سطوح زنجیره ۶۴ بایت است (چون هش پایه SHA-256 است). */
export const HMAC_BLOCK = 64;

/**
 * HMAC عمومی روی «تابع هش دلخواه» — معادل hmac.New(h, key) در Go.
 * برای KDF تودرتوی VMess، پارامتر hash خودش یک HMAC سطح قبل است.
 */
export function hmacWith(hash: (m: Uint8Array) => Uint8Array, key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > HMAC_BLOCK) k = hash(k);
  const ipad = new Uint8Array(HMAC_BLOCK + msg.length);
  const opad = new Uint8Array(HMAC_BLOCK + 32);
  for (let i = 0; i < HMAC_BLOCK; i++) {
    const kb = i < k.length ? k[i]! : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  ipad.set(msg, HMAC_BLOCK);
  opad.set(hash(ipad), HMAC_BLOCK);
  return hash(opad);
}
