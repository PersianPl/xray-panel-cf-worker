/**
 * Keccak-f[1600] — پایه‌ی SHA3/SHAKE.
 * WebCrypto SHA3/SHAKE ندارد؛ برای SHAKE128 (ماسک chunkهای VMess)
 * و SHA3-224 (هش Trojan) لازم است. بردار تست در tests/keccak.spec.ts.
 */

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTC = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(v: bigint, n: number): bigint {
  const n64 = BigInt(n % 64);
  return ((v << n64) | (v >> (64n - n64))) & 0xffffffffffffffffn;
}

function keccakF(state: BigUint64Array): void {
  // حالت: state[x + 5y] = A[x][y]
  for (let round = 0; round < 24; round++) {
    // θ
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[x + y * 5] = state[x + y * 5]! ^ d;
    }
    // ρ و π : B[y][(2x+3y)%5] = rotl(A[x][y], r[x][y])
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        b[nx + ny * 5] = rotl64(state[x + y * 5]!, ROTC[x]![y]!);
      }
    }
    // χ : B[x][y] XOR (نبودِ B[x+1][y] AND B[x+2][y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + y * 5] = b[x + y * 5]! ^ ((~b[((x + 1) % 5) + y * 5]!) & b[((x + 2) % 5) + y * 5]!);
      }
    }
    // ι
    state[0] = state[0]! ^ RC[round]!;
  }
}

/** جریان sponge Keccak — مشترک بین SHA3 (پدینگ 0x06) و SHAKE (پدینگ 0x1f). */
export class Keccak {
  private readonly state = new BigUint64Array(25);
  private readonly rate: number; // بایت
  private readonly padByte: number;
  private readonly buf: Uint8Array;
  private pos = 0;
  private finished = false;
  /** بلوک خروجی جاری (سریالایزِ state) و شمارنده‌ی مصرف — برای squeeze جریانی. */
  private out: Uint8Array;
  private outPos = 0;

  constructor(rateBytes: number, padByte: number) {
    this.rate = rateBytes;
    this.padByte = padByte;
    this.buf = new Uint8Array(rateBytes);
    this.out = new Uint8Array(rateBytes);
  }

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('keccak: update after finish');
    let i = 0;
    // تکمیل بلوک نیم‌پر قبلی
    if (this.pos > 0) {
      const need = Math.min(this.rate - this.pos, data.length);
      this.buf.set(data.subarray(0, need), this.pos);
      this.pos += need;
      i = need;
      if (this.pos === this.rate) {
        this.absorb(this.buf);
        this.pos = 0;
      }
    }
    // بلوک‌های کامل
    while (i + this.rate <= data.length) {
      this.absorb(data.subarray(i, i + this.rate));
      i += this.rate;
    }
    // باقی‌مانده
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.pos = data.length - i;
    }
    return this;
  }

  private absorb(block: Uint8Array): void {
    for (let i = 0; i < this.rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(block[i * 8 + j]!);
      this.state[i] = this.state[i]! ^ lane;
    }
    keccakF(this.state);
  }

  /** فینالایز با پدینگ Keccak؛ پس از آن فقط read مجاز است. */
  finish(): void {
    if (this.finished) return;
    const padded = new Uint8Array(this.rate);
    padded.set(this.buf.subarray(0, this.pos));
    padded[this.pos] = this.padByte;
    padded[this.rate - 1]! |= 0x80;
    this.absorb(padded);
    this.finished = true;
    this.pos = 0;
    this.squeezeBlock();
  }

  /** state جاری را به بلوک خروجی سریالایز می‌کند (little-endian per lane). */
  private squeezeBlock(): void {
    const lanes = this.rate / 8;
    for (let i = 0; i < lanes; i++) {
      let lane = this.state[i]!;
      for (let j = 0; j < 8; j++) {
        this.out[i * 8 + j] = Number(lane & 0xffn);
        lane >>= 8n;
      }
    }
    this.outPos = 0;
  }

  /**
   * خواندن n بایت از جریان خروجی (بعد از finish) — جریانی و ادامه‌دار:
   * فراخوانی‌های متوالی read(2) بایت‌های بعدی را می‌دهند، نه تکرار بایت‌های اول.
   */
  read(n: number): Uint8Array {
    if (!this.finished) throw new Error('keccak: read before finish');
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      if (this.outPos === this.rate) {
        keccakF(this.state);
        this.squeezeBlock();
      }
      const take = Math.min(this.rate - this.outPos, n - off);
      out.set(this.out.subarray(this.outPos, this.outPos + take), off);
      this.outPos += take;
      off += take;
    }
    return out;
  }
}

/** SHAKE128 (rate=168 بایت) — ماسک chunkهای VMess. */
export function shake128(seed: Uint8Array): { read(n: number): Uint8Array } {
  const k = new Keccak(168, 0x1f);
  k.update(seed);
  k.finish();
  return { read: (n: number) => k.read(n) };
}

/** SHA3-224 (rate=144 بایت) — هش رمز Trojan به‌صورت hex. */
export function sha3_224hex(data: Uint8Array): string {
  const k = new Keccak(144, 0x06);
  k.update(data);
  k.finish();
  const out = k.read(28);
  let s = '';
  for (const b of out) s += b.toString(16).padStart(2, '0');
  return s;
}

export function sha3_256hex(data: Uint8Array): string {
  const k = new Keccak(136, 0x06);
  k.update(data);
  k.finish();
  const out = k.read(32);
  let s = '';
  for (const b of out) s += b.toString(16).padStart(2, '0');
  return s;
}
