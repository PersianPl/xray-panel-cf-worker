/**
 * تولید QR — پیاده‌سازی کامل و بدون وابستگی (ISO/IEC 18004).
 *
 * چرا نه سرویس بیرونی: تنها چیزی که در QR می‌رود، **لینک اشتراک کاربر** است.
 * فرستادنش به `api.qrserver.com` یا هر سرویس دیگری یعنی لو دادن همان چیزی که
 * کل پنل برای مخفی نگه‌داشتنش ساخته شده. پس اینجا خودمان می‌سازیم.
 *
 * فقط حالت byte (8-bit) پیاده شده — لینک‌ها ASCII/UTF-8 هستند و حالت‌های
 * numeric/alphanumeric فقط چند بایت صرفه‌جویی می‌کردند در برابر کد بیشتر.
 * خروجی SVG است تا در هر اندازه‌ای تیز بماند و به canvas نیاز نباشد.
 */

/** سطح تصحیح خطا. `M` تعادل معمول برای QR روی نمایشگر است. */
export type EccLevel = 'L' | 'M' | 'Q' | 'H';

const ECC_ORDER: EccLevel[] = ['L', 'M', 'Q', 'H'];

/** تعداد کدوردهای تصحیح خطا در هر بلوک — به‌ازای [سطح][نسخه]. */
const ECC_PER_BLOCK: Record<EccLevel, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** تعداد بلوک‌های تصحیح خطا — به‌ازای [سطح][نسخه]. */
const ECC_BLOCKS: Record<EccLevel, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** تعداد کل ماژول‌های داده (بیت) در یک نسخه، بدون الگوهای ثابت. */
function rawDataBits(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver: number, ecc: EccLevel): number {
  return Math.floor(rawDataBits(ver) / 8) - ECC_PER_BLOCK[ecc][ver]! * ECC_BLOCKS[ecc][ver]!;
}

// ───────────────────────── میدان گالوا GF(256) ─────────────────────────
// چندجمله‌ای مولد QR: x^8 + x^4 + x^3 + x^2 + 1 = 0x11d

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/**
 * چندجمله‌ای مولد Reed-Solomon درجه‌ی `degree`، به‌ترتیب **نزولی**
 * (`gen[0]` ضریب x^degree است و همیشه ۱).
 *
 * ساخت به‌صورت صعودی نوشته شده چون خواندنش ساده‌تر است (index = توان x)، ولی
 * تقسیم در `rsRemainder` ترتیب نزولی می‌خواهد، پس در پایان برگردانده می‌شود.
 * قبلاً همین ناهم‌خوانی باعث می‌شد ضریب اشتباه در تقسیم استفاده شود.
 */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ gfMul(poly[j]!, EXP[i]!);
      next[j + 1] = next[j + 1]! ^ poly[j]!;
    }
    poly = next;
  }
  return poly.reverse();
}

/**
 * کدوردهای تصحیح خطای یک بلوک داده — باقی‌مانده‌ی تقسیم بر چندجمله‌ای مولد.
 * `rem[0]` بالاترین درجه است، پس `copyWithin(0, 1)` یعنی ضرب در x.
 */
function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    // gen[0] همان ضریب پیشرو (۱) است و در تقسیم کنار گذاشته می‌شود.
    for (let i = 0; i < degree; i++) rem[i] = rem[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

// ───────────────────────────── بیت‌نویس ─────────────────────────────

class BitBuffer {
  bits: number[] = [];
  push(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

/** کوچک‌ترین نسخه‌ای که داده در آن جا می‌شود. */
function pickVersion(byteLen: number, ecc: EccLevel, min = 1, max = 40): number | null {
  for (let ver = min; ver <= max; ver++) {
    const cap = dataCodewords(ver, ecc) * 8;
    // ۴ بیت حالت + شمارنده‌ی طول (۸ بیت تا نسخه‌ی ۹، بعد ۱۶ بیت)
    const need = 4 + (ver < 10 ? 8 : 16) + byteLen * 8;
    if (need <= cap) return ver;
  }
  return null;
}

/** داده را به کدوردهای نهایی (داده + ECC، اینترلیوشده) تبدیل می‌کند. */
function encodeCodewords(data: Uint8Array, ver: number, ecc: EccLevel): Uint8Array {
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // حالت byte
  bb.push(data.length, ver < 10 ? 8 : 16);
  for (const b of data) bb.push(b, 8);

  const capBits = dataCodewords(ver, ecc) * 8;
  // terminator: تا ۴ بیت صفر، بعد padding تا مرز بایت
  bb.push(0, Math.min(4, capBits - bb.length));
  bb.push(0, (8 - (bb.length % 8)) % 8);

  const words: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j]!;
    words.push(v);
  }
  // بایت‌های پرکننده‌ی استاندارد، متناوب
  for (let pad = 0xec; words.length < dataCodewords(ver, ecc); pad ^= 0xec ^ 0x11) words.push(pad);

  const blocks = ECC_BLOCKS[ecc][ver]!;
  const eccLen = ECC_PER_BLOCK[ecc][ver]!;
  const total = Math.floor(rawDataBits(ver) / 8);
  const shortLen = Math.floor(total / blocks) - eccLen;
  const numShort = blocks - (total % blocks);

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const chunk = new Uint8Array(words.slice(off, off + len));
    off += len;
    dataBlocks.push(chunk);
    eccBlocks.push(rsRemainder(chunk, eccLen));
  }

  // اینترلیو: بایت i از همه‌ی بلوک‌ها، سپس ECC به همان ترتیب
  const out: number[] = [];
  const maxData = shortLen + 1;
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  }
  for (let i = 0; i < eccLen; i++) {
    for (const b of eccBlocks) out.push(b[i]!);
  }
  return new Uint8Array(out);
}

// ───────────────────────────── ماتریس ─────────────────────────────

/**
 * مرکز الگوهای تراز، به‌ازای هر نسخه — صعودی.
 *
 * موقعیت‌ها از لبه‌ی راست/پایین به‌عقب شمرده می‌شوند و ۶ همیشه اولی است؛ نسخه‌ی
 * ۳۲ تنها استثنایی است که فرمول گام جواب درست نمی‌دهد و مقدارش دستی است.
 */
function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const last = size - 7;
  const step = ver === 32 ? 26 : Math.ceil((last - 6) / (n - 1) / 2) * 2;
  const out = [6];
  // درج در جای دوم (نه ابتدا) تا خروجی صعودی بماند و ۶ اول فهرست بایستد.
  for (let p = last; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

/** یک ماتریس QR ساخته‌شده، آماده‌ی رندر. */
export interface QrMatrix {
  size: number;
  /** `true` = ماژول تیره. */
  modules: boolean[][];
  version: number;
  ecc: EccLevel;
}

/**
 * الگوهای ثابت یک نسخه را می‌سازد: یاب‌ها، جداکننده‌ها، زمان‌بندی، ترازها،
 * ماژول تیره‌ی همیشگی، رزرو ناحیه‌ی فرمت، و اطلاعات نسخه (۷ و بالاتر).
 *
 * `fixed` نقشه‌ی «ماژول تابعی» است: داده رویشان نمی‌نشیند و ماسک هم عوضشان
 * نمی‌کند. نگه‌داشتن این نقشه به‌جای حدس‌زدن از مختصات، تنها راهی است که با
 * الگوهای تراز نسخه‌های بالا هم دقیق می‌ماند.
 */
function functionPatterns(version: number): { size: number; dark: boolean[][]; fixed: boolean[][] } {
  const size = version * 4 + 17;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const put = (r: number, c: number, v: boolean): void => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    dark[r]![c] = v;
    fixed[r]![c] = true;
  };
  const reserve = (r: number, c: number): void => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    fixed[r]![c] = true;
  };

  // الگوی یاب ۷×۷ به‌همراه جداکننده‌ی یک‌ماژولی دورش
  const setFinder = (r: number, c: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        put(r + dr, c + dc, inRing ? d !== 2 : false);
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // الگوهای زمان‌بندی
  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  // الگوهای تراز (روی الگوهای یاب نمی‌نشینند)
  const aligns = alignPositions(version);
  for (const r of aligns) {
    for (const c of aligns) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // ناحیه‌ی اطلاعات فرمت فقط رزرو می‌شود؛ مقدارش بعد از انتخاب ماسک می‌آید.
  put(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    reserve(8, i);
    reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserve(8, size - 1 - i);
    reserve(size - 1 - i, 8);
  }

  // اطلاعات نسخه (نسخه‌ی ۷ و بالاتر)
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      put(a, b, on);
      put(b, a, on);
    }
  }

  return { size, dark, fixed };
}

/**
 * ماتریس QR را می‌سازد: الگوهای ثابت، داده، و انتخاب بهترین ماسک.
 * هر هشت ماسک ساخته و امتیازدهی می‌شود (طبق §7.8.3) و کم‌جریمه‌ترین می‌ماند —
 * این کار خوانایی را روی دوربین‌های ضعیف محسوس بهتر می‌کند.
 */
export function makeQr(text: string, ecc: EccLevel = 'M'): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length, ecc);
  if (version === null) throw new Error('داده برای QR بیش از حد بزرگ است');

  const words = encodeCodewords(data, version, ecc);
  const { size, dark, fixed } = functionPatterns(version);

  placeData(dark, fixed, words, size);
  const mask = chooseMask(dark, fixed, size, ecc);
  applyMask(dark, fixed, size, mask);
  placeFormat(dark, size, ecc, mask);

  return { size, modules: dark, version, ecc };
}

/** بیت‌های اطلاعات نسخه با کد BCH(18,6). */
function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((ver << 12) | rem) >>> 0;
}

/**
 * داده را در ناحیه‌های خالی می‌چیند: ستون‌های دوتایی از راست به چپ، با جهت
 * عمودی متناوب. ستون ۶ (الگوی زمان‌بندی) در شمارش ستون‌ها نمی‌آید، پس بعد از
 * رسیدن به آن یک ستون جا می‌اندازیم — بدون این، همه‌ی بیت‌ها یک خانه می‌لغزند.
 */
function placeData(dark: boolean[][], fixed: boolean[][], words: Uint8Array, size: number): void {
  let bit = 0;
  const total = words.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // ستون ۶ زمان‌بندی است؛ از آن به بعد جفت‌ستون‌ها یکی چپ‌تر می‌شوند.
    const r0 = right <= 6 ? right - 1 : right;
    for (let v = 0; v < size; v++) {
      const r = upward ? size - 1 - v : v;
      for (const c of [r0, r0 - 1]) {
        if (c < 0 || fixed[r]![c]) continue;
        const on = bit < total ? ((words[bit >>> 3]! >>> (7 - (bit & 7))) & 1) === 1 : false;
        dark[r]![c] = on;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(dark: boolean[][], fixed: boolean[][], size: number, mask: number): void {
  const fn = MASKS[mask]!;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (fixed[r]![c]) continue;
      if (fn(r, c)) dark[r]![c] = !dark[r]![c];
    }
  }
}

/**
 * ماسکی که کمترین جریمه را می‌دهد (ISO §7.8.3).
 * بیت‌های فرمت هر نامزد هم قبل از امتیازدهی نوشته می‌شوند، چون خودشان به ماسک
 * وابسته‌اند و در جریمه‌ی «۵ ماژول هم‌رنگ» اثر دارند.
 */
function chooseMask(dark: boolean[][], fixed: boolean[][], size: number, ecc: EccLevel): number {
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(dark, fixed, size, m);
    placeFormat(dark, size, ecc, m);
    const score = penalty(dark, size);
    applyMask(dark, fixed, size, m); // XOR خودمعکوس است
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** چهار قاعده‌ی جریمه‌ی استاندارد. */
function penalty(m: boolean[][], size: number): number {
  let score = 0;

  // قاعده‌ی ۱: هر ۵ ماژول هم‌رنگ پشت‌سرهم = ۳، هر ماژول اضافه +۱
  for (let i = 0; i < size; i++) {
    for (const line of [m[i]!, m.map((row) => row[i]!)]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // قاعده‌ی ۲: هر بلوک ۲×۲ هم‌رنگ = ۳
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }

  // قاعده‌ی ۳: الگوی شبیهِ یاب (1:1:3:1:1 با چهار ماژول روشن یک‌طرف) = ۴۰
  const pat = [true, false, true, true, true, false, true];
  const light4 = [false, false, false, false];
  const seqMatch = (line: boolean[], at: number, seq: boolean[]): boolean => {
    for (let i = 0; i < seq.length; i++) if (line[at + i] !== seq[i]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    const lines = [m[i]!, m.map((row) => row[i]!)];
    for (const line of lines) {
      for (let j = 0; j + 7 <= size; j++) {
        if (!seqMatch(line, j, pat)) continue;
        const before = j - 4 >= 0 && seqMatch(line, j - 4, light4);
        const after = j + 7 + 4 <= size && seqMatch(line, j + 7, light4);
        if (before || after) score += 40;
      }
    }
  }

  // قاعده‌ی ۴: انحراف نسبت ماژول‌های تیره از ۵۰٪
  let darkCount = 0;
  for (const row of m) for (const v of row) if (v) darkCount++;
  const percent = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** بیت‌های اطلاعات فرمت با BCH(15,5) و ماسک ثابت 0x5412. */
function formatBits(ecc: EccLevel, mask: number): number {
  const eccBits = [1, 0, 3, 2][ECC_ORDER.indexOf(ecc)]!;
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * بیت‌های فرمت را در **دو** جای مقرر می‌نویسد (ISO §7.9.1، شکل ۲۵).
 *
 * نسخه‌ی اول دور الگوی یاب بالا-چپ می‌پیچد: بیت‌های ۰ تا ۵ عمودی در ستون ۸
 * (سطرهای ۰ تا ۵)، بیت ۶ در (۷,۸)، بیت ۷ در (۸,۸)، بیت ۸ در (۸,۷)، و بیت‌های
 * ۹ تا ۱۴ افقی در سطر ۸ (ستون ۵ تا ۰).
 *
 * نسخه‌ی دوم برعکس است: بیت‌های ۰ تا ۷ افقی در سطر ۸ از لبه‌ی راست، و بیت‌های
 * ۸ تا ۱۴ عمودی در ستون ۸ از لبه‌ی پایین. جابه‌جا نوشتن سطر و ستون در هرکدام،
 * ترانهاده‌ی درست را می‌سازد که هیچ اسکنری نمی‌خواند و از ظاهر ماتریس هم پیدا
 * نیست — فقط با بردار شناخته‌شده لو می‌رود.
 */
function placeFormat(dark: boolean[][], size: number, ecc: EccLevel, mask: number): void {
  const bits = formatBits(ecc, mask);

  for (let i = 0; i <= 5; i++) dark[i]![8] = bit(bits, i);
  dark[7]![8] = bit(bits, 6);
  dark[8]![8] = bit(bits, 7);
  dark[8]![7] = bit(bits, 8);
  for (let i = 9; i < 15; i++) dark[8]![14 - i] = bit(bits, i);

  for (let i = 0; i < 8; i++) dark[8]![size - 1 - i] = bit(bits, i);
  for (let i = 8; i < 15; i++) dark[size - 15 + i]![8] = bit(bits, i);
  dark[size - 8]![8] = true; // ماژول تیره‌ی ثابت
}

function bit(v: number, i: number): boolean {
  return ((v >>> i) & 1) === 1;
}

/**
 * توابع درونی، فقط برای تست.
 *
 * جداول ECC و ریاضیات RS جایی در API عمومی لازم نیستند، ولی بدون دسترسی به آن‌ها
 * تست فقط می‌تواند خروجی نهایی را ببیند و نمی‌تواند بگوید خطا از جدول است یا از
 * چیدمان بیت‌ها. این شیء همان تفکیک را ممکن می‌کند.
 */
export const QR_INTERNALS = {
  dataCodewords,
  rawDataBits,
  rsGenerator,
  rsRemainder,
  gfMul,
  versionBits,
  formatBits,
  eccBlocks: (ecc: EccLevel, ver: number): number => ECC_BLOCKS[ecc][ver]!,
  eccPerBlock: (ecc: EccLevel, ver: number): number => ECC_PER_BLOCK[ecc][ver]!,
  alignPositions,
  pickVersion,
  functionPatterns,
  encodeCodewords,
  penalty,
  applyMask,
  MASKS,
};

/**
 * ماتریس را به SVG می‌برد.
 *
 * تمام ماژول‌های تیره در **یک** مسیر `<path>` جمع می‌شوند نه هزار `<rect>`:
 * حجم خروجی چند برابر کمتر می‌شود و مرورگر هم سریع‌تر رندر می‌کند (برای نسخه‌ی
 * ۱۰ تفاوت حدود ۴۰KB در برابر ۴KB است).
 */
export function qrSvg(text: string, opts: { ecc?: EccLevel; margin?: number; size?: number; dark?: string; light?: string } = {}): string {
  const m = makeQr(text, opts.ecc ?? 'M');
  const margin = opts.margin ?? 2;
  const total = m.size + margin * 2;
  const px = opts.size ?? 0;

  let d = '';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.modules[r]![c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  const dimension = px > 0 ? ` width="${px}" height="${px}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${dimension} shape-rendering="crispEdges" role="img" aria-label="QR">` +
    `<rect width="${total}" height="${total}" fill="${opts.light ?? '#ffffff'}"/>` +
    `<path d="${d}" fill="${opts.dark ?? '#000000'}"/>` +
    `</svg>`
  );
}





