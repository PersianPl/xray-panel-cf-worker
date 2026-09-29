/**
 * ماسک chunk بادی VMess — معادل ShakeSizeParser در v2ray-core:
 * جریان SHAKE128(bodyIV) دو-بایت‌دو-بایت مصرف می‌شود؛ هر Encode/Decode یک جفت
 * و هر NextPaddingLen هم یک جفت (پدینگ = جفت % ۶۴، سقف ۶۴).
 *
 * ترتیب مصرف در هر دو جهت یکی است: **اول NextPaddingLen، بعد طول**
 *   auth.go seal():    paddingSize := padding.NextPaddingLen() → sizeParser.Encode(...)
 *   auth.go readSize(): io.ReadFull(sizeBytes) → padding.NextPaddingLen() → Decode(sizeBytes)
 * خواندنِ بایت‌های خام قبل از پدینگ است، ولی مصرفِ جریان SHAKE در Decode رخ می‌دهد،
 * پس ترتیبِ مؤثر برای هر دو سمت یکسان می‌شود.
 */
import { shake128 } from './keccak';

export class ShakeMask {
  private readonly gen: { read(n: number): Uint8Array };

  constructor(seed: Uint8Array) {
    this.gen = shake128(seed);
  }

  /** یک جفت بایت بعدی از جریان به‌صورت عدد Big-Endian. */
  private next2(): number {
    const b = this.gen.read(2);
    return (b[0]! << 8) | b[1]!;
  }

  /** رمز/رمزگشایی طول ۲ بایتی درجا (XOR است، پس دو طرفه). */
  applySize(b: Uint8Array, off = 0): void {
    const v = ((b[off]! << 8) | b[off + 1]!) ^ this.next2();
    b[off] = (v >> 8) & 0xff;
    b[off + 1] = v & 0xff;
  }

  /** طول پدینگ بعدی (۰ تا ۶۳). */
  nextPaddingLen(): number {
    return this.next2() % 64;
  }

  /** سقف پدینگ — برای حساب‌کردن بیشترین payload یک chunk. */
  static readonly maxPaddingLen = 64;
}

/** nonce بادی: ۲ بایت اول شمارنده‌ی BE، بقیه از iv (معادل GenerateChunkNonce). */
export class ChunkNonce {
  private counter = 0;
  private readonly out: Uint8Array;

  constructor(iv: Uint8Array, size: number) {
    this.out = new Uint8Array(size);
    if (size > 2) this.out.set(iv.subarray(2, size), 2);
  }

  next(): Uint8Array {
    this.out[0] = (this.counter >> 8) & 0xff;
    this.out[1] = this.counter & 0xff;
    this.counter = (this.counter + 1) & 0xffff;
    // کپی می‌دهیم چون فراخوان ممکن است تا مصرفِ بعدی نگهش دارد.
    return this.out.slice(0);
  }
}
