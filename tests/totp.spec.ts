/**
 * تست TOTP (RFC 6238) — بردارهای رسمی، پنجره‌ی انحراف ساعت، و جریان ورود
 * دومرحله‌ای پنل.
 */
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUrl, totp, verifyTotp } from '../src/lib/totp';
import { hashPassword } from '../src/lib/crypto';
import { DEFAULTS, Settings } from '../src/lib/settings';
import { login } from '../src/panel/auth';
import { FakeD1, fakeEnv } from './stubs/d1';
import type { Env } from '../src/types';

/** رمز تستی RFC — همان «12345678901234567890» در ASCII. */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('Base32', () => {
  it('roundtrip — هر رشته‌ی بایتی دوطرفه می‌شود', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(40));
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('فقط حروف مجاز A-Z2-7', () => {
    const s = base32Encode(new Uint8Array([255, 0, 128, 7]));
    expect(s).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('HOTP/TOTP — بردارهای رسمی', () => {
  it('RFC 4226 — کد ۶ رقمی، شمارنده‌های ۰ تا ۹', async () => {
    const expect6 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (let c = 0; c < expect6.length; c++) {
      expect(await hotp(RFC_SECRET, c, 6), `counter=${c}`).toBe(expect6[c]);
    }
  });

  it('RFC 6238 — کد ۸ رقمی، زمان‌های جدول رسمی (شمارنده = کف زمان/۳۰)', async () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [tSec, code] of vectors) {
      expect(await hotp(RFC_SECRET, Math.floor(tSec / 30), 8), `T=${tSec}`).toBe(code);
    }
  });

  it('totp روی رشته‌ی Base32 هم کار می‌کند', async () => {
    const b32 = base32Encode(RFC_SECRET);
    expect(await totp(b32, 30)).toBe(await hotp(RFC_SECRET, 1, 6));
  });
});

describe('verifyTotp', () => {
  const b32 = base32Encode(RFC_SECRET);

  it('کد درست قبول می‌شود', async () => {
    expect(await verifyTotp(b32, await totp(b32, 1000), { at: 1000 })).toBe(true);
  });

  it('پنجره‌ی ±۱ گام — انحراف ۳۰ ثانیه‌ای اوکی، ۹۰ ثانیه‌ای نه', async () => {
    const code = await totp(b32, 1000); // گام ۳۳
    expect(await verifyTotp(b32, code, { at: 1030 })).toBe(true); // گام بعدی
    expect(await verifyTotp(b32, code, { at: 970 })).toBe(true); // گام قبل
    expect(await verifyTotp(b32, code, { at: 1090 })).toBe(false); // دو گام بعد
  });

  it('کد خراب/کوتاه رد می‌شود', async () => {
    expect(await verifyTotp(b32, '12345', { at: 1000 })).toBe(false);
    expect(await verifyTotp(b32, 'abcdef', { at: 1000 })).toBe(false);
    expect(await verifyTotp(b32, '', { at: 1000 })).toBe(false);
  });

  it('رمز خیلی کوتاه رد می‌شود (پیکربندی خراب)', async () => {
    expect(await verifyTotp('AAAA', '123456', { at: 1000 })).toBe(false);
  });
});

describe('رمز و لینک', () => {
  it('رمز جدید: Base32 معتبر با طول ۳۲ (۱۶۰ بیت)', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('otpauth URL همه‌ی پارامترها را دارد', () => {
    const url = otpauthUrl('ABC23456', 'ali@x.com');
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=ABC23456');
    expect(url).toContain('issuer=PersianPl-Panel');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});

describe('ورود دومرحله‌ای پنل', () => {
  const SECRET_B32 = base32Encode(RFC_SECRET);

  function conf(over: Record<string, string> = {}): Settings {
    return new Settings(new Map(Object.entries({ ...DEFAULTS, ...over })));
  }

  async function setupTwoFa(hash: string): Promise<Settings> {
    return conf({ admin_user: 'admin', admin_pass_hash: hash, twofa_enabled: '1', twofa_secret: SECRET_B32 });
  }

  async function doLogin(s: Settings, code: string): Promise<{ ok: boolean; reason?: string }> {
    const db = new FakeD1();
    const env = fakeEnv(db) as unknown as Env;
    return login(env, s, 'admin', 'pass-12345', code, { ip: '1.2.3.4', ua: 'test' });
  }

  it('رمز درست ولی بدون کد → رد', async () => {
    const hash = await hashPassword('pass-12345');
    const out = await doLogin(await setupTwoFa(hash), '');
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('دومرحله');
  });

  it('با کد درست → ورود موفق', async () => {
    const hash = await hashPassword('pass-12345');
    const code = await totp(SECRET_B32); // همین گام — verify پنجره ±۱ دارد
    const out = await doLogin(await setupTwoFa(hash), code);
    expect(out.ok).toBe(true);
  });

  it('با کد اشتباه → رد + لاگ شکست', async () => {
    const db = new FakeD1();
    const hash = await hashPassword('pass-12345');
    const env = fakeEnv(db) as unknown as Env;
    const out = await login(env, await setupTwoFa(hash), 'admin', 'pass-12345', '000000', {
      ip: '1.2.3.4',
      ua: 'test',
    });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('دومرحله') });
    expect(db.find('INSERT INTO audit_log').length).toBe(1);
  });

  it('بدون ۲FA → همان رفتار قدیمی', async () => {
    const hash = await hashPassword('pass-12345');
    const out = await doLogin(conf({ admin_user: 'admin', admin_pass_hash: hash }), '');
    expect(out.ok).toBe(true);
  });
});
