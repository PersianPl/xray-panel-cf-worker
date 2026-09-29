/**
 * ChaCha20-Poly1305 (RFC 8439) خالص — WebCrypto در Workers ندارد،
 * ولی VMess security=4 (chacha20-poly1305) در همه‌ی کلاینت‌ها هست و باید کار کند.
 * کلید VMess: MD5(reqKey) || MD5(MD5(reqKey)).
 */

const ROT = (v: number, n: number): number => ((v << n) | (v >>> (32 - n))) >>> 0;

/** یک بلوک ۶۴ بایتی کلید-جریان ChaCha20. */
function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint8Array): void {
  const x = new Uint32Array(16);
  x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) x[4 + i] = key[i]!;
  x[12] = counter >>> 0;
  x[13] = nonce[0]!; x[14] = nonce[1]!; x[15] = nonce[2]!;

  const s = new Uint32Array(x);
  for (let i = 0; i < 10; i++) {
    qr(s, 0, 4, 8, 12); qr(s, 1, 5, 9, 13); qr(s, 2, 6, 10, 14); qr(s, 3, 7, 11, 15);
    qr(s, 0, 5, 10, 15); qr(s, 1, 6, 11, 12); qr(s, 2, 7, 8, 13); qr(s, 3, 4, 9, 14);
  }
  const dv = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) dv.setUint32(i * 4, (s[i]! + x[i]!) >>> 0, true);
}

function qr(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = ROT(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = ROT(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = ROT(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = ROT(s[b]! ^ s[c]!, 7);
}

function loadKey(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('chacha20: key must be 32 bytes');
  const dv = new DataView(key.buffer, key.byteOffset, 32);
  const k = new Uint32Array(8);
  for (let i = 0; i < 8; i++) k[i] = dv.getUint32(i * 4, true);
  return k;
}

function loadNonce(nonce: Uint8Array): Uint32Array {
  if (nonce.length !== 12) throw new Error('chacha20: nonce must be 12 bytes');
  const dv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  return new Uint32Array([dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true)]);
}

/** XOR جریان ChaCha20 روی داده، با شمارنده‌ی آغازین دلخواه. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, counter = 1): Uint8Array {
  const k = loadKey(key);
  const n = loadNonce(nonce);
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(64);
  for (let off = 0; off < data.length; off += 64) {
    chachaBlock(k, counter++, n, block);
    const len = Math.min(64, data.length - off);
    for (let i = 0; i < len; i++) out[off + i] = data[off + i]! ^ block[i]!;
  }
  return out;
}

/** Poly1305 — ریاضی ۲۶ بیتی (۵ لِمب) تا در محدوده‌ی امن اعداد JS بماند. */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('poly1305: key must be 32 bytes');
  const dv = new DataView(key.buffer, key.byteOffset, 32);
  const t0 = dv.getUint16(0, true), t1 = dv.getUint16(2, true), t2 = dv.getUint16(4, true), t3 = dv.getUint16(6, true);
  const t4 = dv.getUint16(8, true), t5 = dv.getUint16(10, true), t6 = dv.getUint16(12, true), t7 = dv.getUint16(14, true);

  const r = new Int32Array(10);
  r[0] = t0 & 0x1fff;
  r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
  r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
  r[5] = (t4 >>> 1) & 0x1ffe;
  r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
  r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  r[9] = (t7 >>> 5) & 0x007f;

  const pad = new Int32Array(8);
  for (let i = 0; i < 8; i++) pad[i] = dv.getUint16(16 + i * 2, true);

  const h = new Int32Array(10);
  let leftover = 0;
  const buffer = new Uint8Array(16);
  let fin = 0;

  const blocks = (m: Uint8Array, bytes: number, start: number): number => {
    let mPos = start;
    const hibit = fin ? 0 : 1 << 11;
    while (bytes >= 16) {
      const bdv = new DataView(m.buffer, m.byteOffset + mPos, 16);
      const d0 = bdv.getUint16(0, true), d1 = bdv.getUint16(2, true), d2 = bdv.getUint16(4, true), d3 = bdv.getUint16(6, true);
      const d4 = bdv.getUint16(8, true), d5 = bdv.getUint16(10, true), d6 = bdv.getUint16(12, true), d7 = bdv.getUint16(14, true);

      h[0]! += d0 & 0x1fff;
      h[1]! += ((d0 >>> 13) | (d1 << 3)) & 0x1fff;
      h[2]! += ((d1 >>> 10) | (d2 << 6)) & 0x1fff;
      h[3]! += ((d2 >>> 7) | (d3 << 9)) & 0x1fff;
      h[4]! += ((d3 >>> 4) | (d4 << 12)) & 0x1fff;
      h[5]! += (d4 >>> 1) & 0x1fff;
      h[6]! += ((d4 >>> 14) | (d5 << 2)) & 0x1fff;
      h[7]! += ((d5 >>> 11) | (d6 << 5)) & 0x1fff;
      h[8]! += ((d6 >>> 8) | (d7 << 8)) & 0x1fff;
      h[9]! += (d7 >>> 5) | hibit;

      let c = 0;
      const g = new Int32Array(10);
      for (let i = 0; i < 10; i++) {
        let acc = c;
        for (let j = 0; j < 10; j++) {
          acc += h[j]! * (j <= i ? r[i - j]! : 5 * r[i + 10 - j]!);
          if (j === 4) {
            c = acc >>> 13;
            acc &= 0x1fff;
          }
        }
        c += acc >>> 13;
        acc &= 0x1fff;
        g[i] = acc;
      }
      c = (c << 2) + c;
      c += g[0]!;
      g[0] = c & 0x1fff;
      c >>>= 13;
      g[1]! += c;
      for (let i = 0; i < 10; i++) h[i] = g[i]!;

      mPos += 16;
      bytes -= 16;
    }
    return mPos;
  };

  // پیام
  let pos = 0;
  let remaining = msg.length;
  if (remaining >= 16) {
    const want = remaining - (remaining % 16);
    pos = blocks(msg, want, 0);
    remaining -= want;
  }
  if (remaining > 0) {
    buffer.set(msg.subarray(pos, pos + remaining));
    leftover = remaining;
  }

  // نهایی‌سازی
  if (leftover > 0) {
    buffer[leftover++] = 1;
    for (let i = leftover; i < 16; i++) buffer[i] = 0;
    fin = 1;
    blocks(buffer, 16, 0);
  }

  // انتشار carry
  let c = h[1]! >>> 13;
  h[1]! &= 0x1fff;
  for (let i = 2; i < 10; i++) {
    h[i]! += c;
    c = h[i]! >>> 13;
    h[i]! &= 0x1fff;
  }
  h[0]! += c * 5;
  c = h[0]! >>> 13;
  h[0]! &= 0x1fff;
  h[1]! += c;
  c = h[1]! >>> 13;
  h[1]! &= 0x1fff;
  h[2]! += c;

  // h - p
  const g = new Int32Array(10);
  c = 5;
  for (let i = 0; i < 10; i++) {
    g[i] = h[i]! + c;
    c = g[i]! >>> 13;
    g[i]! &= 0x1fff;
  }
  let mask = (c ^ 1) - 1;
  for (let i = 0; i < 10; i++) g[i]! &= mask;
  mask = ~mask;
  for (let i = 0; i < 10; i++) h[i] = (h[i]! & mask) | g[i]!;

  // به ۱۶ بایت
  h[0] = (h[0]! | (h[1]! << 13)) & 0xffff;
  h[1] = ((h[1]! >>> 3) | (h[2]! << 10)) & 0xffff;
  h[2] = ((h[2]! >>> 6) | (h[3]! << 7)) & 0xffff;
  h[3] = ((h[3]! >>> 9) | (h[4]! << 4)) & 0xffff;
  h[4] = ((h[4]! >>> 12) | (h[5]! << 1) | (h[6]! << 14)) & 0xffff;
  h[5] = ((h[6]! >>> 2) | (h[7]! << 11)) & 0xffff;
  h[6] = ((h[7]! >>> 5) | (h[8]! << 8)) & 0xffff;
  h[7] = ((h[8]! >>> 8) | (h[9]! << 5)) & 0xffff;

  let f = h[0]! + pad[0]!;
  h[0] = f & 0xffff;
  for (let i = 1; i < 8; i++) {
    f = (((h[i]! + pad[i]!) | 0) + (f >>> 16)) | 0;
    h[i] = f & 0xffff;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint16(i * 2, h[i]! & 0xffff, true);
  return out;
}

/** آرایه‌ی خالی مشترک — مقدار پیش‌فرض aad. */
const EMPTY: Uint8Array = new Uint8Array(0);

/** ورودی MAC مطابق RFC 8439 §2.8: aad|pad16|ct|pad16|len(aad)|len(ct) (۸ بایتی LE). */
function macData(aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const padA = (16 - (aad.length % 16)) % 16;
  const padC = (16 - (ct.length % 16)) % 16;
  const out = new Uint8Array(aad.length + padA + ct.length + padC + 16);
  let o = 0;
  out.set(aad, o); o += aad.length + padA;
  out.set(ct, o); o += ct.length + padC;
  const dv = new DataView(out.buffer, out.byteOffset + o, 16);
  dv.setUint32(0, aad.length >>> 0, true);
  dv.setUint32(4, Math.floor(aad.length / 4294967296) >>> 0, true);
  dv.setUint32(8, ct.length >>> 0, true);
  dv.setUint32(12, Math.floor(ct.length / 4294967296) >>> 0, true);
  return out;
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function chacha20poly1305Seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = EMPTY): Uint8Array {
  const polyKey = chacha20(key, nonce, new Uint8Array(32), 0);
  const ct = chacha20(key, nonce, plaintext, 1);
  const tag = poly1305(polyKey, macData(aad, ct));
  const out = new Uint8Array(ct.length + 16);
  out.set(ct);
  out.set(tag, ct.length);
  return out;
}

export function chacha20poly1305Open(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array = EMPTY): Uint8Array | null {
  if (data.length < 16) return null;
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const polyKey = chacha20(key, nonce, new Uint8Array(32), 0);
  const want = poly1305(polyKey, macData(aad, ct));
  if (!ctEqual(tag, want)) return null;
  return chacha20(key, nonce, ct, 1);
}
