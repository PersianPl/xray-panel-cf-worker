/**
 * AES-128 بلوکی خالص — فقط جایی که WebCrypto ندارد:
 * ECB-دکیکریپت AuthID وِمِس و CFB-128 هدر پاسخ آن (هر دو ≤ ۱۶ بایت دیتا).
 * State ستونی مطابق FIPS-197: s[r + 4c].
 */

// ── SBox با ساخت برنامه‌نویسی‌شده ──
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(() => {
  const pow = new Uint8Array(256); // 3^i
  const log = new Uint8Array(256); // log base 3
  let x = 1;
  for (let i = 0; i < 255; i++) {
    pow[i] = x;
    log[x] = i;
    x = x ^ ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0x1ff; // x *= 3 در GF(2^8)
    x &= 0xff;
  }
  pow[255] = 1; // 3^255 = 1
  const inv = (a: number): number => (a === 0 ? 0 : pow[255 - log[a]!]!);
  for (let i = 0; i < 256; i++) {
    let u = inv(i);
    const t0 = u;
    let t = u;
    for (let k = 1; k <= 4; k++) {
      t = ((t << 1) | (t >>> 7)) & 0xff;
      u ^= t;
    }
    u ^= 0x63;
    SBOX[i] = u;
    INV_SBOX[SBOX[i]!] = i;
    void t0;
  }
})();

const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

const xt = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
function gmul(a: number, b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    a = xt(a);
    b >>= 1;
  }
  return r & 0xff;
}

export interface Aes128 {
  encryptBlock(block: Uint8Array, off?: number): void;
  decryptBlock(block: Uint8Array, off?: number): void;
}

export function aes128(key: Uint8Array): Aes128 {
  if (key.length !== 16) throw new Error('aes128: key must be 16 bytes');

  // بسط کلید — ۱۱ کلید دور، ۱۷۶ بایت
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4]!, t1 = w[i - 3]!, t2 = w[i - 2]!, t3 = w[i - 1]!;
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1]! ^ RCON[i / 16 - 1]!;
      t1 = SBOX[t2]!;
      t2 = SBOX[t3]!;
      t3 = SBOX[tmp]!;
    }
    w[i] = w[i - 16]! ^ t0;
    w[i + 1] = w[i - 15]! ^ t1;
    w[i + 2] = w[i - 14]! ^ t2;
    w[i + 3] = w[i - 13]! ^ t3;
  }

  const s = new Uint8Array(16);
  const load = (b: Uint8Array, o: number): void => { s.set(b.subarray(o, o + 16)); };
  const store = (b: Uint8Array, o: number): void => { b.subarray(o, o + 16).set(s); };
  const ark = (rnd: number): void => { for (let i = 0; i < 16; i++) s[i] = s[i]! ^ w[rnd * 16 + i]!; };

  /** SubBytes + ShiftRows + MixColumns. */
  const subShiftMix = (): void => {
    const out = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) out[r + 4 * c] = SBOX[s[r + 4 * ((c + r) % 4)]!]!;
    }
    mixColumns(out);
  };

  /** فقط ShiftRows + SubBytes (دور آخر). */
  const subShift = (): void => {
    const out = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) out[r + 4 * c] = SBOX[s[r + 4 * ((c + r) % 4)]!]!;
    }
    s.set(out);
  };

  /** InvShiftRows + InvSubBytes + InvMixColumns. */
  const invShiftSubMix = (): void => {
    const out = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) out[r + 4 * c] = INV_SBOX[s[r + 4 * ((c + 4 - r) % 4)]!]!;
    }
    invMixColumns(out);
  };

  /** فقط InvShiftRows + InvSubBytes (دور آخر). */
  const invShiftSub = (): void => {
    const out = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) out[r + 4 * c] = INV_SBOX[s[r + 4 * ((c + 4 - r) % 4)]!]!;
    }
    s.set(out);
  };

  const mixColumns = (from: Uint8Array): void => {
    for (let c = 0; c < 4; c++) {
      const a0 = from[4 * c]!, a1 = from[4 * c + 1]!, a2 = from[4 * c + 2]!, a3 = from[4 * c + 3]!;
      s[4 * c] = xt(a0) ^ (a1 ^ xt(a1)) ^ a2 ^ a3;
      s[4 * c + 1] = a0 ^ xt(a1) ^ (a2 ^ xt(a2)) ^ a3;
      s[4 * c + 2] = a0 ^ a1 ^ xt(a2) ^ (a3 ^ xt(a3));
      s[4 * c + 3] = (a0 ^ xt(a0)) ^ a1 ^ a2 ^ xt(a3);
    }
  };

  const invMixColumns = (from: Uint8Array): void => {
    for (let c = 0; c < 4; c++) {
      const a0 = from[4 * c]!, a1 = from[4 * c + 1]!, a2 = from[4 * c + 2]!, a3 = from[4 * c + 3]!;
      s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  };

  return {
    encryptBlock(block, off = 0): void {
      load(block, off);
      ark(0);
      for (let r = 1; r < 10; r++) {
        subShiftMix();
        ark(r);
      }
      subShift();
      ark(10);
      store(block, off);
    },
    decryptBlock(block, off = 0): void {
      // InvCipher استاندارد FIPS-197 §5.3 (کلیدهای دور خام، نه معادل‌سازی‌شده)
      load(block, off);
      ark(10);
      for (let r = 9; r >= 1; r--) {
        invShiftSub();
        ark(r);
        invMixColumns(new Uint8Array(s));
      }
      invShiftSub();
      ark(0);
      store(block, off);
    },
  };
}

/** CFB-128 — دیتای ما همیشه ≤ ۱۶ بایت است (هدر ۴ بایتی پاسخ وِمِس). */
export function aes128cfbEncrypt(aes: Aes128, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const stream = iv.slice(0, 16);
  aes.encryptBlock(stream, 0);
  for (let j = 0; j < data.length; j++) {
    out[j] = data[j]! ^ stream[j]!;
    stream[j] = out[j]!;
  }
  return out;
}

export function aes128cfbDecrypt(aes: Aes128, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const stream = iv.slice(0, 16);
  aes.encryptBlock(stream, 0);
  for (let j = 0; j < data.length; j++) {
    out[j] = data[j]! ^ stream[j]!;
    stream[j] = data[j]!;
  }
  return out;
}
