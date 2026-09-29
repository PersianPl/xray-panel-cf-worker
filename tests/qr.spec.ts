/**
 * تست تولید QR — با بردارهای شناخته‌شده و یک **رمزگشای مستقل**.
 *
 * چرا رمزگشا: کد QR پر از جای‌گذاری بیت است و همه‌ی خطاهایش «سازگارِ باخودش»
 * ظاهر می‌شوند. اگر تست فقط چیزی را بسنجد که خود کد نوشته، یک ماتریسِ کاملاً
 * ناخوانا هم قبول می‌شود. پس اینجا ماتریس دوباره **خوانده** می‌شود: ماسک از
 * بیت‌های فرمت بازیابی می‌شود، پیمایش زیگزاگ مستقل از پیاده‌سازی نوشته شده،
 * بلوک‌ها از هم باز می‌شوند و باقی‌مانده‌ی Reed-Solomon هرکدام بررسی می‌شود.
 * تنها در این حالت است که «متن اصلی برگشت» چیزی را ثابت می‌کند.
 */
import { describe, expect, it } from 'vitest';
import { QR_INTERNALS, makeQr, qrSvg, type EccLevel, type QrMatrix } from '../src/lib/qr';

const LEVELS: EccLevel[] = ['L', 'M', 'Q', 'H'];

/** بیت‌های فرمت استاندارد — جدول C.1 استاندارد، ۳۲ ترکیب سطح×ماسک. */
const FORMAT_STRINGS: Record<EccLevel, string[]> = {
  L: [
    '111011111000100', '111001011110011', '111110110101010', '111100010011101',
    '110011000101111', '110001100011000', '110110001000001', '110100101110110',
  ],
  M: [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000',
  ],
  Q: [
    '011010101011111', '011000001101000', '011111100110001', '011101000000110',
    '010010010110100', '010000110000011', '010111011011010', '010101111101101',
  ],
  H: [
    '001011010001001', '001001110111110', '001110011100111', '001100111010000',
    '000011101100010', '000001001010101', '000110100001100', '000100000111011',
  ],
};

/** بیت‌های نسخه — جدول D.1 استاندارد. */
const VERSION_STRINGS: Record<number, string> = {
  7: '000111110010010100',
  10: '001010010011010011',
  20: '010100100110100110',
  40: '101000110001101001',
};

/** ستون «تعداد کدورد داده» جدول تصحیح خطا، برای چند نسخه‌ی نمونه. */
const DATA_CODEWORDS: Array<[number, EccLevel, number]> = [
  [1, 'L', 19], [1, 'M', 16], [1, 'Q', 13], [1, 'H', 9],
  [5, 'Q', 62], [7, 'H', 66], [10, 'M', 216], [13, 'H', 180],
  [20, 'Q', 485], [25, 'L', 1276], [32, 'L', 1955], [40, 'L', 2956],
  [40, 'M', 2334], [40, 'Q', 1666], [40, 'H', 1276],
];

/** [نسخه، سطح] → [تعداد بلوک، کدورد ECC هر بلوک]. */
const BLOCK_TABLE: Array<[number, EccLevel, number, number]> = [
  [1, 'L', 1, 7], [1, 'H', 1, 17], [5, 'Q', 4, 18], [8, 'H', 6, 26],
  [11, 'H', 11, 24], [13, 'H', 16, 22], [22, 'H', 34, 24], [34, 'H', 60, 30],
  [36, 'H', 66, 30], [40, 'H', 81, 30], [40, 'L', 25, 30], [40, 'Q', 68, 30],
];

function bin(v: number, len: number): string {
  let s = '';
  for (let i = len - 1; i >= 0; i--) s += (v >>> i) & 1 ? '1' : '0';
  return s;
}

/**
 * جدول کامل تصحیح خطا (ISO/IEC 18004 جدول ۹) — هر ردیف یک نسخه، و برای هر سطح
 * سه عدد: [کدورد داده، کدورد ECC در هر بلوک، تعداد بلوک]. ترتیب سطح‌ها L,M,Q,H.
 * این جدول تنها مرجع بیرونی این تست است؛ همه‌ی محاسبات دیگر باید با آن جور باشند.
 */
const ECC_TABLE: number[][] = [
  /* v1  */ [19, 7, 1, 16, 10, 1, 13, 13, 1, 9, 17, 1],
  /* v2  */ [34, 10, 1, 28, 16, 1, 22, 22, 1, 16, 28, 1],
  /* v3  */ [55, 15, 1, 44, 26, 1, 34, 18, 2, 26, 22, 2],
  /* v4  */ [80, 20, 1, 64, 18, 2, 48, 26, 2, 36, 16, 4],
  /* v5  */ [108, 26, 1, 86, 24, 2, 62, 18, 4, 46, 22, 4],
  /* v6  */ [136, 18, 2, 108, 16, 4, 76, 24, 4, 60, 28, 4],
  /* v7  */ [156, 20, 2, 124, 18, 4, 88, 18, 6, 66, 26, 5],
  /* v8  */ [194, 24, 2, 154, 22, 4, 110, 22, 6, 86, 26, 6],
  /* v9  */ [232, 30, 2, 182, 22, 5, 132, 20, 8, 100, 24, 8],
  /* v10 */ [274, 18, 4, 216, 26, 5, 154, 24, 8, 122, 28, 8],
  /* v11 */ [324, 20, 4, 254, 30, 5, 180, 28, 8, 140, 24, 11],
  /* v12 */ [370, 24, 4, 290, 22, 8, 206, 26, 10, 158, 28, 11],
  /* v13 */ [428, 26, 4, 334, 22, 9, 244, 24, 12, 180, 22, 16],
  /* v14 */ [461, 30, 4, 365, 24, 9, 261, 20, 16, 197, 24, 16],
  /* v15 */ [523, 22, 6, 415, 24, 10, 295, 30, 12, 223, 24, 18],
  /* v16 */ [589, 24, 6, 453, 28, 10, 325, 24, 17, 253, 30, 16],
  /* v17 */ [647, 28, 6, 507, 28, 11, 367, 28, 16, 283, 28, 19],
  /* v18 */ [721, 30, 6, 563, 26, 13, 397, 28, 18, 313, 28, 21],
  /* v19 */ [795, 28, 7, 627, 26, 14, 445, 26, 21, 341, 26, 25],
  /* v20 */ [861, 28, 8, 669, 26, 16, 485, 30, 20, 385, 28, 25],
  /* v21 */ [932, 28, 8, 714, 26, 17, 512, 28, 23, 406, 30, 25],
  /* v22 */ [1006, 28, 9, 782, 28, 17, 568, 30, 23, 442, 24, 34],
  /* v23 */ [1094, 30, 9, 860, 28, 18, 614, 30, 25, 464, 30, 30],
  /* v24 */ [1174, 30, 10, 914, 28, 20, 664, 30, 27, 514, 30, 32],
  /* v25 */ [1276, 26, 12, 1000, 28, 21, 718, 30, 29, 538, 30, 35],
  /* v26 */ [1370, 28, 12, 1062, 28, 23, 754, 28, 34, 596, 30, 37],
  /* v27 */ [1468, 30, 12, 1128, 28, 25, 808, 30, 34, 628, 30, 40],
  /* v28 */ [1531, 30, 13, 1193, 28, 26, 871, 30, 35, 661, 30, 42],
  /* v29 */ [1631, 30, 14, 1267, 28, 28, 911, 30, 38, 701, 30, 45],
  /* v30 */ [1735, 30, 15, 1373, 28, 29, 985, 30, 40, 745, 30, 48],
  /* v31 */ [1843, 30, 16, 1455, 28, 31, 1033, 30, 43, 793, 30, 51],
  /* v32 */ [1955, 30, 17, 1541, 28, 33, 1115, 30, 45, 845, 30, 54],
  /* v33 */ [2071, 30, 18, 1631, 28, 35, 1171, 30, 48, 901, 30, 57],
  /* v34 */ [2191, 30, 19, 1725, 28, 37, 1231, 30, 51, 961, 30, 60],
  /* v35 */ [2306, 30, 19, 1812, 28, 38, 1286, 30, 53, 986, 30, 63],
  /* v36 */ [2434, 30, 20, 1914, 28, 40, 1354, 30, 56, 1054, 30, 66],
  /* v37 */ [2566, 30, 21, 1992, 28, 43, 1426, 30, 59, 1096, 30, 70],
  /* v38 */ [2702, 30, 22, 2102, 28, 45, 1502, 30, 62, 1142, 30, 74],
  /* v39 */ [2812, 30, 24, 2216, 28, 47, 1582, 30, 65, 1222, 30, 77],
  /* v40 */ [2956, 30, 25, 2334, 28, 49, 1666, 30, 68, 1276, 30, 81],
];

/** مرکز الگوهای تراز (ISO/IEC 18004 پیوست E) — ایندکس = نسخه. */
const ALIGN_TABLE: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

/**
 * «آیا این خانه ماژول تابعی است؟» — نوشته‌شده **از روی استاندارد**، نه از روی
 * پیاده‌سازی. اگر نقشه‌ی `fixed` کد اصلی خراب باشد، این تابع اختلاف را نشان
 * می‌دهد؛ استفاده از خودِ `fixed` در رمزگشا آن خرابی را پنهان می‌کرد.
 */
function isFunctionModule(r: number, c: number, version: number): boolean {
  const size = version * 4 + 17;

  // سه گوشه: یاب + جداکننده + ناحیه‌ی اطلاعات فرمت، به‌شکل بلوک‌های توپر
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;

  // زمان‌بندی
  if (r === 6 || c === 6) return true;

  // اطلاعات نسخه
  if (version >= 7) {
    if (r <= 5 && c >= size - 11 && c <= size - 9) return true;
    if (c <= 5 && r >= size - 11 && r <= size - 9) return true;
  }

  // ترازها — «نزدیک یک مرکز» با جدول از پیش ساخته‌شده تا جست‌وجوی دوحلقه‌ای
  // به‌ازای هر خانه تکرار نشود (روی نسخه‌ی ۴۰ تفاوتش محسوس است).
  const near = alignNear(version);
  const rc = near[r];
  return rc ? rc.has(c) : false;
}

/** برای هر سطر، مجموعه‌ی ستون‌هایی که داخل یک الگوی تراز می‌افتند. */
const ALIGN_NEAR_CACHE = new Map<number, Array<Set<number> | undefined>>();

function alignNear(version: number): Array<Set<number> | undefined> {
  const hit = ALIGN_NEAR_CACHE.get(version);
  if (hit) return hit;

  const size = version * 4 + 17;
  const centers = ALIGN_TABLE[version]!;
  const out: Array<Set<number> | undefined> = new Array(size);
  for (const cr of centers) {
    for (const cc of centers) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6)) continue;
      for (let r = cr - 2; r <= cr + 2; r++) {
        let s = out[r];
        if (!s) {
          s = new Set<number>();
          out[r] = s;
        }
        for (let c = cc - 2; c <= cc + 2; c++) s.add(c);
      }
    }
  }
  ALIGN_NEAR_CACHE.set(version, out);
  return out;
}

// ─────────────────── ریاضیات GF(256) مستقل، برای بررسی سندروم ───────────────────

const G_EXP = new Uint8Array(512);
const G_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    G_EXP[i] = x;
    G_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) G_EXP[i] = G_EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : G_EXP[G_LOG[a]! + G_LOG[b]!]!;
}

/**
 * بررسی سندروم: یک کدواژه‌ی معتبر Reed-Solomon در ریشه‌های α^0..α^(d-1) صفر
 * می‌شود. این سنجه از ساخت چندجمله‌ای مولد مستقل است، پس اگر `rsGenerator`
 * ترتیب ضرایبش برعکس باشد اینجا لو می‌رود — چیزی که مقایسه‌ی خروجی با خودش
 * هرگز نشان نمی‌داد.
 */
function syndromeOk(codeword: Uint8Array, degree: number): boolean {
  for (let i = 0; i < degree; i++) {
    let acc = 0;
    for (const b of codeword) acc = mul(acc, G_EXP[i]!) ^ b;
    if (acc !== 0) return false;
  }
  return true;
}

// ─────────────────────────── رمزگشای مستقل ───────────────────────────

interface Decoded {
  text: string;
  version: number;
  ecc: EccLevel;
  mask: number;
  /** آیا همه‌ی بلوک‌ها سندروم صفر داشتند. */
  blocksValid: boolean;
}

const MASK_FNS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** سطح و ماسک را از پانزده بیت فرمتِ نسخه‌ی اول بازیابی می‌کند. */
function readFormat(m: boolean[][], size: number): { ecc: EccLevel; mask: number; raw: string } {
  const b: boolean[] = [];
  for (let i = 0; i <= 5; i++) b[i] = m[i]![8]!;
  b[6] = m[7]![8]!;
  b[7] = m[8]![8]!;
  b[8] = m[8]![7]!;
  for (let i = 9; i < 15; i++) b[i] = m[8]![14 - i]!;

  // رشته را با ترتیب پرارزش-به-کم‌ارزش می‌سازیم تا با جدول استاندارد جور شود.
  let raw = '';
  for (let i = 14; i >= 0; i--) raw += b[i] ? '1' : '0';

  for (const level of LEVELS) {
    const idx = FORMAT_STRINGS[level].indexOf(raw);
    if (idx >= 0) return { ecc: level, mask: idx, raw };
  }
  throw new Error(`بیت‌های فرمت با هیچ ترکیب استانداردی جور نشد: ${raw}`);
}

/** بیت‌های داده را با پیمایش زیگزاگ می‌خواند (مستقل از پیاده‌سازی اصلی). */
function readCodewords(m: boolean[][], size: number, version: number, mask: number): Uint8Array {
  const fn = MASK_FNS[mask]!;
  const bits: number[] = [];
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    const r0 = right <= 6 ? right - 1 : right;
    for (let v = 0; v < size; v++) {
      const r = upward ? size - 1 - v : v;
      for (const c of [r0, r0 - 1]) {
        if (c < 0 || isFunctionModule(r, c, version)) continue;
        // ماسک برداشته می‌شود: XOR خودمعکوس است.
        bits.push((m[r]![c]! !== fn(r, c)) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!;
    out[i] = v;
  }
  return out;
}

/**
 * کدوردهای اینترلیوشده را به بلوک‌های اصلی برمی‌گرداند.
 * بلوک‌های کوتاه اول می‌آیند، پس بایت آخرِ بلوک‌های بلند در دور آخرِ اینترلیو
 * فقط برای همان‌ها گذاشته شده — منطق برگرداندن باید همین را برعکس کند.
 */
function deinterleave(words: Uint8Array, version: number, ecc: EccLevel): Uint8Array[] {
  const row = ECC_TABLE[version - 1]!;
  const at = LEVELS.indexOf(ecc) * 3;
  const dataTotal = row[at]!;
  const eccLen = row[at + 1]!;
  const blocks = row[at + 2]!;

  const shortLen = Math.floor(dataTotal / blocks);
  const numLong = dataTotal % blocks;
  const lens = Array.from({ length: blocks }, (_, i) => shortLen + (i >= blocks - numLong ? 1 : 0));

  const data: number[][] = lens.map(() => []);
  let p = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < lens[b]!) data[b]!.push(words[p++]!);
    }
  }
  const parity: number[][] = lens.map(() => []);
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < blocks; b++) parity[b]!.push(words[p++]!);
  }

  return lens.map((_, b) => new Uint8Array([...data[b]!, ...parity[b]!]));
}

/** ماتریس را کامل رمزگشایی می‌کند: فرمت → ماسک → کدورد → بلوک → متن. */
function decode(q: QrMatrix): Decoded {
  const { modules: m, size, version } = q;
  const { ecc, mask } = readFormat(m, size);
  const words = readCodewords(m, size, version, mask);
  const blocks = deinterleave(words, version, ecc);

  const row = ECC_TABLE[version - 1]!;
  const eccLen = row[LEVELS.indexOf(ecc) * 3 + 1]!;
  const blocksValid = blocks.every((b) => syndromeOk(b, eccLen));

  // بایت‌های داده به‌ترتیب بلوک‌ها (بدون ECC) پشت هم می‌آیند.
  const dataBytes: number[] = [];
  for (const b of blocks) dataBytes.push(...b.subarray(0, b.length - eccLen));

  const bits: number[] = [];
  for (const byte of dataBytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);

  let p = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (bits[p++] ?? 0);
    return v;
  };

  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`حالت رمزگذاری غیرمنتظره: ${mode.toString(2)}`);
  const len = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = take(8);

  return { text: new TextDecoder().decode(bytes), version, ecc, mask, blocksValid };
}

// ─────────────────────────────── تست‌ها ───────────────────────────────

describe('جداول تصحیح خطا', () => {
  it('تعداد کدورد داده با جدول استاندارد برای هر ۴۰ نسخه × ۴ سطح جور است', () => {
    for (let ver = 1; ver <= 40; ver++) {
      const row = ECC_TABLE[ver - 1]!;
      LEVELS.forEach((level, i) => {
        expect(QR_INTERNALS.dataCodewords(ver, level), `v${ver}-${level}`).toBe(row[i * 3]!);
      });
    }
  });

  it('تعداد بلوک و کدورد ECC هر بلوک با جدول استاندارد جور است', () => {
    for (let ver = 1; ver <= 40; ver++) {
      const row = ECC_TABLE[ver - 1]!;
      LEVELS.forEach((level, i) => {
        expect(QR_INTERNALS.eccPerBlock(level, ver), `ECC v${ver}-${level}`).toBe(row[i * 3 + 1]!);
        expect(QR_INTERNALS.eccBlocks(level, ver), `بلوک v${ver}-${level}`).toBe(row[i * 3 + 2]!);
      });
    }
  });

  it('جمع داده + ECC دقیقاً کل ظرفیت نسخه را پر می‌کند', () => {
    // این اتحاد ساختاری است: هیچ کدوردی نباید بی‌استفاده بماند.
    for (let ver = 1; ver <= 40; ver++) {
      const total = Math.floor(QR_INTERNALS.rawDataBits(ver) / 8);
      for (const level of LEVELS) {
        const data = QR_INTERNALS.dataCodewords(ver, level);
        const parity = QR_INTERNALS.eccPerBlock(level, ver) * QR_INTERNALS.eccBlocks(level, ver);
        expect(data + parity, `v${ver}-${level}`).toBe(total);
      }
    }
  });

  it('انتخاب نسخه کوچک‌ترین نسخه‌ی ممکن را برمی‌دارد', () => {
    // ظرفیت byte-mode نسخه‌ی ۱ سطح L طبق استاندارد ۱۷ بایت است.
    expect(QR_INTERNALS.pickVersion(17, 'L')).toBe(1);
    expect(QR_INTERNALS.pickVersion(18, 'L')).toBe(2);
    expect(QR_INTERNALS.pickVersion(14, 'M')).toBe(1);
    expect(QR_INTERNALS.pickVersion(7, 'H')).toBe(1);
    expect(QR_INTERNALS.pickVersion(8, 'H')).toBe(2);
    expect(QR_INTERNALS.pickVersion(2953, 'L')).toBe(40);
    expect(QR_INTERNALS.pickVersion(2954, 'L')).toBeNull();
  });
});

describe('بیت‌های فرمت و نسخه', () => {
  it('همه‌ی ۳۲ ترکیب سطح×ماسک با جدول C.1 استاندارد یکسان است', () => {
    for (const level of LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        expect(bin(QR_INTERNALS.formatBits(level, mask), 15), `${level}/${mask}`).toBe(FORMAT_STRINGS[level][mask]);
      }
    }
  });

  it('بیت‌های نسخه با جدول D.1 استاندارد یکسان است', () => {
    for (const [ver, want] of Object.entries(VERSION_STRINGS)) {
      expect(bin(QR_INTERNALS.versionBits(Number(ver)), 18), `v${ver}`).toBe(want);
    }
  });

  it('فاصله‌ی همینگ بیت‌های فرمت حداقل ۷ است', () => {
    // BCH(15,5) باید ۳ خطا را تصحیح کند؛ فاصله‌ی کمتر یعنی جدول خراب است.
    const all: number[] = [];
    for (const level of LEVELS) for (let m = 0; m < 8; m++) all.push(QR_INTERNALS.formatBits(level, m));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        let x = all[i]! ^ all[j]!;
        let d = 0;
        while (x) {
          d += x & 1;
          x >>>= 1;
        }
        expect(d).toBeGreaterThanOrEqual(7);
      }
    }
  });
});

describe('ریاضیات Reed-Solomon', () => {
  it('چندجمله‌ای مولد درجه‌ی ۷ با مقدار استاندارد جور است', () => {
    // g(x) برای ۷ کدورد ECC — ضرایب نزولی، از جدول شناخته‌شده‌ی QR.
    expect([...QR_INTERNALS.rsGenerator(7)]).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
  });

  it('چندجمله‌ای مولد درجه‌ی ۱۰ با مقدار استاندارد جور است', () => {
    expect([...QR_INTERNALS.rsGenerator(10)]).toEqual([1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  });

  it('ضریب پیشرو همیشه ۱ است و طول = درجه+۱', () => {
    for (const d of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
      const g = QR_INTERNALS.rsGenerator(d);
      expect(g.length).toBe(d + 1);
      expect(g[0]).toBe(1);
    }
  });

  it('کدواژه‌ی داده+ECC در ریشه‌های میدان صفر می‌شود', () => {
    // بررسی سندروم با پیاده‌سازی GF مستقل — تنها سنجه‌ای که ترتیب ضرایب مولد را
    // واقعاً می‌آزماید.
    const data = new Uint8Array([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    for (const d of [7, 10, 13, 17]) {
      const parity = QR_INTERNALS.rsRemainder(data, d);
      expect(parity.length).toBe(d);
      expect(syndromeOk(new Uint8Array([...data, ...parity]), d), `درجه ${d}`).toBe(true);
    }
  });

  it('ECC نمونه‌ی معروف «HELLO WORLD» نسخه‌ی ۱ سطح Q درست است', () => {
    // بردار مرجع از آموزش استاندارد Thonky؛ داده و ECC هر دو معلوم است.
    const data = new Uint8Array([67, 85, 70, 134, 87, 38, 85, 194, 119, 50, 6, 18, 6, 103, 38]);
    const want = [213, 199, 11, 45, 115, 247, 241, 223, 229, 248, 154, 117, 154, 111, 86, 161, 111, 39];
    expect([...QR_INTERNALS.rsRemainder(data, 18)]).toEqual(want);
  });
});

describe('الگوهای تراز', () => {
  it('مراکز با پیوست E استاندارد برای هر ۴۰ نسخه جور است', () => {
    for (let ver = 2; ver <= 40; ver++) {
      expect(QR_INTERNALS.alignPositions(ver), `v${ver}`).toEqual(ALIGN_TABLE[ver]);
    }
  });

  it('نسخه‌ی ۱ الگوی تراز ندارد', () => {
    expect(QR_INTERNALS.alignPositions(1)).toEqual([]);
  });
});

describe('ساختار ماتریس', () => {
  it('اندازه = نسخه×۴+۱۷', () => {
    for (const [text, ecc] of [['a', 'M'], ['x'.repeat(60), 'M'], ['y'.repeat(500), 'L']] as Array<[string, EccLevel]>) {
      const q = makeQr(text, ecc);
      expect(q.size).toBe(q.version * 4 + 17);
      expect(q.modules.length).toBe(q.size);
      expect(q.modules.every((r) => r.length === q.size)).toBe(true);
    }
  });

  it('نقشه‌ی ماژول‌های تابعی با استاندارد جور است (همه‌ی نسخه‌ها)', () => {
    // اگر `fixed` جایی کم/زیاد باشد، داده روی الگوی ثابت می‌افتد یا یک خانه‌ی
    // داده هدر می‌رود و همه‌ی بیت‌های بعدی می‌لغزند — خرابی‌ای که از ظاهر
    // ماتریس پیدا نیست.
    for (let ver = 1; ver <= 40; ver++) {
      const { size, fixed } = QR_INTERNALS.functionPatterns(ver);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          expect(fixed[r]![c], `v${ver} (${r},${c})`).toBe(isFunctionModule(r, c, ver));
        }
      }
    }
  });

  it('سه الگوی یاب با نقش‌مایه‌ی ۱:۱:۳:۱:۱ ساخته می‌شوند', () => {
    const q = makeQr('https://example.com/sub/abc', 'M');
    const m = q.modules;
    for (const [r0, c0] of [[0, 0], [0, q.size - 7], [q.size - 7, 0]] as Array<[number, number]>) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          expect(m[r0 + dr]![c0 + dc], `یاب (${r0},${c0}) خانه (${dr},${dc})`).toBe(ring !== 2);
        }
      }
    }
  });

  it('جداکننده‌ی دور الگوهای یاب همیشه روشن است', () => {
    const q = makeQr('test-separator', 'Q');
    const m = q.modules;
    const s = q.size;
    for (let i = 0; i < 8; i++) {
      expect(m[7]![i], `افقی بالا-چپ ${i}`).toBe(false);
      expect(m[i]![7], `عمودی بالا-چپ ${i}`).toBe(false);
      expect(m[7]![s - 1 - i], `افقی بالا-راست ${i}`).toBe(false);
      expect(m[s - 8]![i], `افقی پایین-چپ ${i}`).toBe(false);
    }
  });

  it('الگوهای زمان‌بندی متناوب‌اند', () => {
    const q = makeQr('timing-pattern-check', 'M');
    for (let i = 8; i < q.size - 8; i++) {
      expect(q.modules[6]![i], `افقی ${i}`).toBe(i % 2 === 0);
      expect(q.modules[i]![6], `عمودی ${i}`).toBe(i % 2 === 0);
    }
  });

  it('ماژول تیره‌ی ثابت در (size−8, 8) همیشه تیره است', () => {
    for (const ecc of LEVELS) {
      const q = makeQr('dark-module', ecc);
      expect(q.modules[q.size - 8]![8], ecc).toBe(true);
    }
  });

  it('دو نسخه‌ی بیت‌های فرمت با هم یکسان‌اند', () => {
    // اگر نسخه‌ی دوم یک خانه بلغزد، اسکنرهایی که فقط نسخه‌ی اول را می‌خوانند
    // موفق می‌شوند و خرابی سال‌ها پنهان می‌ماند.
    const q = makeQr('https://example.com/sub/format-copy-test', 'H');
    const m = q.modules;
    const s = q.size;
    const { mask, ecc } = readFormat(m, s);
    const bits = QR_INTERNALS.formatBits(ecc, mask);
    const on = (i: number): boolean => ((bits >>> i) & 1) === 1;

    for (let i = 0; i < 8; i++) expect(m[8]![s - 1 - i], `نسخه۲ افقی بیت ${i}`).toBe(on(i));
    for (let i = 8; i < 15; i++) expect(m[s - 15 + i]![8], `نسخه۲ عمودی بیت ${i}`).toBe(on(i));
  });

  it('اطلاعات نسخه در نسخه‌ی ۷ و بالاتر نوشته و در پایین‌تر نوشته نمی‌شود', () => {
    const small = makeQr('a'.repeat(30), 'M'); // نسخه‌ی زیر ۷
    expect(small.version).toBeLessThan(7);

    const big = makeQr('b'.repeat(200), 'M');
    expect(big.version).toBeGreaterThanOrEqual(7);
    const bits = QR_INTERNALS.versionBits(big.version);
    for (let i = 0; i < 18; i++) {
      const want = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + big.size - 11;
      expect(big.modules[a]![b], `بلوک بالا-راست بیت ${i}`).toBe(want);
      expect(big.modules[b]![a], `بلوک پایین-چپ بیت ${i}`).toBe(want);
    }
  });
});

describe('رمزگشایی رفت‌وبرگشتی', () => {
  it('متن ساده در هر چهار سطح تصحیح خطا برمی‌گردد', () => {
    for (const ecc of LEVELS) {
      const q = makeQr('HELLO WORLD', ecc);
      const d = decode(q);
      expect(d.text, ecc).toBe('HELLO WORLD');
      expect(d.ecc, ecc).toBe(ecc);
      expect(d.blocksValid, `سندروم ${ecc}`).toBe(true);
    }
  });

  it('لینک واقعی اشتراک برمی‌گردد', () => {
    const url = 'https://panel.example.workers.dev/sub/k7m2p9qrst4vwxyz';
    const q = makeQr(url, 'M');
    const d = decode(q);
    expect(d.text).toBe(url);
    expect(d.blocksValid).toBe(true);
  });

  it('لینک vless با پارامترهای کامل برمی‌گردد', () => {
    // این طولانی‌ترین چیزی است که واقعاً در QR پنل می‌رود.
    const link =
      'vless://8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8@1.2.3.4:8443?encryption=none&security=tls' +
      '&sni=panel.example.com&fp=chrome&type=ws&host=panel.example.com&path=%2Fabcdef%3Fed%3D2560' +
      '&alpn=h2%2Chttp%2F1.1#PersianPl-Germany-8443';
    const q = makeQr(link, 'M');
    const d = decode(q);
    expect(d.text).toBe(link);
    expect(d.blocksValid).toBe(true);
  });

  it('متن فارسی (UTF-8 چندبایتی) برمی‌گردد', () => {
    const fa = 'اشتراک کاربر — علی · ۳۰ گیگ · تا ۱۴۰۵/۰۶/۱۵';
    const q = makeQr(fa, 'M');
    expect(decode(q).text).toBe(fa);
  });

  it('طول‌های مرزی هر نسخه درست رمزگشایی می‌شوند', () => {
    // نقطه‌ی سرریز نسخه: آخرین طولِ جاشو و اولین طولی که نسخه را جلو می‌برد.
    for (const ecc of LEVELS) {
      for (let ver = 1; ver <= 12; ver++) {
        const cap = QR_INTERNALS.dataCodewords(ver, ecc) - (ver < 10 ? 2 : 3);
        if (cap <= 0) continue;
        const text = 'A'.repeat(cap);
        const q = makeQr(text, ecc);
        expect(q.version, `${ecc} v${ver} طول ${cap}`).toBe(ver);
        const d = decode(q);
        expect(d.text.length, `${ecc} v${ver}`).toBe(cap);
        expect(d.blocksValid, `سندروم ${ecc} v${ver}`).toBe(true);
      }
    }
  });

  it('نسخه‌های بالا با چند بلوک و بلوک‌های نامساوی درست اینترلیو می‌شوند', () => {
    // نسخه‌ی ۱۰ سطح M دو گروه بلوک با طول متفاوت دارد (۴×۴۳ + ۱×۴۴)؛ اگر
    // اینترلیو غلط باشد فقط همین حالت‌ها خراب می‌شوند نه نسخه‌های تک‌بلوکی.
    for (const [len, ecc] of [[200, 'M'], [400, 'L'], [300, 'Q'], [250, 'H'], [1200, 'L']] as Array<[number, EccLevel]>) {
      const text = 'x'.repeat(len);
      const q = makeQr(text, ecc);
      expect(QR_INTERNALS.eccBlocks(ecc, q.version)).toBeGreaterThan(1);
      const d = decode(q);
      expect(d.text, `${ecc}/${len}`).toBe(text);
      expect(d.blocksValid, `سندروم ${ecc}/${len}`).toBe(true);
    }
  });

  it('بزرگ‌ترین ورودی ممکن (نسخه‌ی ۴۰ سطح L) برمی‌گردد', () => {
    const text = 'Z'.repeat(2953);
    const q = makeQr(text, 'L');
    expect(q.version).toBe(40);
    const d = decode(q);
    expect(d.text).toBe(text);
    expect(d.blocksValid).toBe(true);
  });

  it('ورودی بزرگ‌تر از ظرفیت خطا می‌دهد', () => {
    expect(() => makeQr('Z'.repeat(2954), 'L')).toThrow(/بزرگ/);
  });

  it('ماسک بازیابی‌شده همان ماسکی است که در ماتریس اعمال شده', () => {
    // بازیابی ماسک از بیت‌های فرمت + برداشتنش با همان تابع → داده‌ی سالم.
    // اگر شماره‌ی ماسک درست ولی تابعش اشتباه باشد، سندروم می‌شکند.
    for (const ecc of LEVELS) {
      for (const len of [10, 40, 90]) {
        const text = 'q'.repeat(len);
        const d = decode(makeQr(text, ecc));
        expect(d.mask).toBeGreaterThanOrEqual(0);
        expect(d.mask).toBeLessThan(8);
        expect(d.text).toBe(text);
      }
    }
  });
});

/** بایت‌های داده‌ی یک جریان اینترلیوشده، بدون ECC و به‌ترتیب بلوک‌ها. */
function dataOf(words: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const eccLen = ECC_TABLE[version - 1]![LEVELS.indexOf(ecc) * 3 + 1]!;
  const out: number[] = [];
  for (const b of deinterleave(words, version, ecc)) out.push(...b.subarray(0, b.length - eccLen));
  return new Uint8Array(out);
}

describe('پایان‌بند و بایت‌های پرکننده', () => {
  it('پس از داده چهار بیت صفرِ پایان‌بند می‌آید', () => {
    for (const [ver, ecc, len] of [[1, 'L', 8], [4, 'M', 20], [12, 'Q', 30]] as Array<[number, EccLevel, number]>) {
      const words = QR_INTERNALS.encodeCodewords(new Uint8Array(len).fill(0x41), ver, ecc);
      const bytes = dataOf(words, ver, ecc);
      const bits: number[] = [];
      for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
      const used = 4 + (ver < 10 ? 8 : 16) + len * 8;
      expect(bits.slice(used, used + 4), `v${ver}-${ecc}`).toEqual([0, 0, 0, 0]);
    }
  });

  it('بایت‌های پرکننده به‌ترتیب 0xEC و 0x11 متناوب‌اند', () => {
    // استاندارد §7.4.10 این دو بایت را یکی‌درمیان می‌خواهد. رمزگشا فقط `len` بایت
    // اول را می‌خواند، پس اگر پرکننده ثابت بماند هیچ تست رفت‌وبرگشتی خبردار
    // نمی‌شود؛ خروجی اما دیگر با استاندارد جور نیست و اسکنرهای سخت‌گیر
    // (و بازخوانی‌های مبتنی بر ECC) می‌توانند ردش کنند.
    for (const [ver, ecc] of [[1, 'L'], [3, 'M'], [10, 'Q'], [15, 'H'], [25, 'H']] as Array<[number, EccLevel]>) {
      const cap = QR_INTERNALS.dataCodewords(ver, ecc);
      const bytes = dataOf(QR_INTERNALS.encodeCodewords(new Uint8Array(8).fill(0x42), ver, ecc), ver, ecc);
      expect(bytes.length, `v${ver}-${ecc}`).toBe(cap);
      // پایان‌بند ۴ بیتی و بعد صفرهای هم‌ترازی → اولین بایت پرکننده اینجاست.
      const first = Math.ceil((4 + (ver < 10 ? 8 : 16) + 64 + 4) / 8);
      expect(cap, `v${ver}-${ecc} باید پرکننده داشته باشد`).toBeGreaterThan(first);
      for (let i = first; i < cap; i++) {
        expect(bytes[i], `v${ver}-${ecc} بایت ${i}`).toBe((i - first) % 2 === 0 ? 0xec : 0x11);
      }
    }
  });
});






