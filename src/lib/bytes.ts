/**
 * ابزارهای بایت — بدون وابستگی.
 */

export function concat(...parts: Array<Uint8Array>): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u16be(v: number): [number, number] {
  return [(v >> 8) & 0xff, v & 0xff];
}

export function u32be(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/** بایت‌های یک عدد ۶۴ بیتی Big-Endian (برای timestamp در VMess). */
export function u64be(v: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = Math.floor(v);
  for (let i = 7; i >= 0; i--) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

export function readU16be(b: Uint8Array, off = 0): number {
  return (b[off]! << 8) | b[off + 1]!;
}

export function readU32be(b: Uint8Array, off = 0): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** CRC32 (IEEE) — جدولی؛ برای VMess AuthID. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** تبدیل امن Uint8Array به ArrayBuffer (برای WebCrypto). */
export function ab(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** یک Writer ساده روی آرایه‌ی بایت. */
export class ByteWriter {
  private parts: Uint8Array[] = [];
  private len = 0;
  write(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }
  byte(v: number): void {
    this.write(new Uint8Array([v & 0xff]));
  }
  u16(v: number): void {
    const [a, b] = u16be(v);
    this.write(new Uint8Array([a, b]));
  }
  toBytes(): Uint8Array {
    return concat(...this.parts);
  }
  get length(): number {
    return this.len;
  }
}
