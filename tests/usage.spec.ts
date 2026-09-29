/**
 * تست انباشت و نوشتن آمار مصرف.
 *
 * چیزی که اینجا مهم است، «داده‌ی نهایی در جدول» نیست — چون خودِ ماژول جدولی
 * ندارد و همه‌چیز را به D1 می‌سپارد. چیزی که مهم است **شکل عبارت‌هایی است که
 * فرستاده می‌شود**: جمع‌بستنی بودن (`up = up + ?`)، شرط یک‌بار-مصرفِ
 * `first_seen = 0`، سقف ۴۰ عبارت در هر دسته، و برگشتن دلتاها وقتی نوشتن
 * می‌شکند. یک SQLite واقعی همین‌ها را پنهان می‌کرد چون نتیجه‌ی نهایی یکی است.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flush, hasPending, pendingOf, record, resetUsage, setNodeName, utcDay } from '../src/lib/usage';
import { FakeD1 } from './stubs/d1';
import type { Env } from '../src/types';

const db = new FakeD1();
const env = { DB: db } as unknown as Env;

afterEach(() => {
  resetUsage();
  db.reset();
});

/** آرگومان‌های اولین عبارتی که SQLش شامل `part` است. */
function argsOf(part: string): unknown[] {
  const hit = db.find(part)[0];
  if (!hit) throw new Error(`عبارتی با «${part}» اجرا نشده`);
  return hit.args;
}

describe('utcDay', () => {
  it('قالب YYYY-MM-DD به‌وقت UTC', () => {
    expect(utcDay(Date.UTC(2026, 8, 4, 23, 59, 59))).toBe('2026-09-04');
    expect(utcDay(Date.UTC(2026, 8, 5, 0, 0, 0))).toBe('2026-09-05');
  });

  it('ساعت محلی روی نتیجه اثر ندارد', () => {
    // نود در هر منطقه‌ی زمانی که باشد باید همان کلید روز را بسازد، وگرنه آمار
    // روزانه‌ی چند نود روی هم نمی‌افتد.
    expect(utcDay(0)).toBe('1970-01-01');
  });
});

describe('record و pendingOf', () => {
  it('دلتاها جمع می‌شوند', () => {
    record(1, 100, 200);
    record(1, 50, 25);
    expect(pendingOf(1)).toBe(375);
  });

  it('کاربر بی‌سابقه صفر است', () => {
    expect(pendingOf(999)).toBe(0);
  });

  it('کاربران از هم جدا می‌مانند', () => {
    record(1, 10, 0);
    record(2, 0, 20);
    expect(pendingOf(1)).toBe(10);
    expect(pendingOf(2)).toBe(20);
  });

  it('hasPending وضعیت را درست می‌گوید', () => {
    expect(hasPending()).toBe(false);
    record(1, 0, 0);
    expect(hasPending()).toBe(true);
  });

  it('نشست بدون ترافیک هم ثبت می‌شود (برای last_online)', () => {
    record(7, 0, 0);
    expect(hasPending()).toBe(true);
    expect(pendingOf(7)).toBe(0);
  });
});

describe('flush — شکل عبارت‌ها', () => {
  it('مصرف با جمع نوشته می‌شود، نه با set', () => {
    // اگر `up = ?` باشد، آمار نودهای دیگر و همین نود در بازه‌ی قبل پاک می‌شود.
    record(5, 100, 200, { at: Date.UTC(2026, 8, 4, 12) });
    return flush(env).then(() => {
      const sql = db.find('UPDATE clients SET up')[0]!.sql;
      expect(sql).toContain('up = up + ?');
      expect(sql).toContain('down = down + ?');
      expect(sql).toContain('last_online = MAX(last_online, ?)');
      expect(argsOf('UPDATE clients SET up')).toEqual([100, 200, Math.floor(Date.UTC(2026, 8, 4, 12) / 1000), 5]);
    });
  });

  it('آمار روزانه با ON CONFLICT جمع می‌شود', async () => {
    setNodeName('de-1');
    record(5, 10, 20, { at: Date.UTC(2026, 8, 4, 1) });
    await flush(env);
    const row = db.find('client_usage_daily')[0]!;
    expect(row.sql).toContain('up = up + excluded.up');
    expect(row.args).toEqual([5, '2026-09-04', 'de-1', 10, 20]);
  });

  it('مصرف دو روز مختلف در دو ردیف جدا می‌رود', async () => {
    record(5, 10, 0, { at: Date.UTC(2026, 8, 4, 23) });
    record(5, 5, 0, { at: Date.UTC(2026, 8, 5, 1) });
    await flush(env);
    const days = db.find('client_usage_daily').map((x) => x.args[1]);
    expect(days.sort()).toEqual(['2026-09-04', '2026-09-05']);
    // ولی مجموع در جدول کاربر یک UPDATE است.
    expect(db.find('UPDATE clients SET up')).toHaveLength(1);
  });

  it('نشست بدون ترافیک ردیف روزانه نمی‌سازد', async () => {
    record(5, 0, 0);
    await flush(env);
    expect(db.find('client_usage_daily')).toHaveLength(0);
  });

  it('IP با colo ثبت می‌شود و تکراری‌ها یکی می‌شوند', async () => {
    record(5, 1, 0, { ip: '1.2.3.4', colo: 'FRA' });
    record(5, 1, 0, { ip: '1.2.3.4', colo: 'FRA' });
    record(5, 1, 0, { ip: '5.6.7.8', colo: 'AMS' });
    await flush(env);
    const ips = db.find('client_ips').map((x) => x.args[1]);
    expect(ips.sort()).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('آمار inbound جدا نوشته می‌شود', async () => {
    record(5, 10, 20, { inboundId: 3 });
    record(6, 5, 5, { inboundId: 3 });
    await flush(env);
    expect(argsOf('UPDATE inbounds SET up')).toEqual([15, 25, 3]);
  });

  it('inbound بدون ترافیک ردیف نمی‌سازد', async () => {
    record(5, 0, 0, { inboundId: 3 });
    await flush(env);
    expect(db.find('UPDATE inbounds')).toHaveLength(0);
  });

  it('activate شرط یک‌بار-مصرف first_seen = 0 را دارد', async () => {
    // بدون این شرط، هر اتصالِ بعدی تاریخ انقضای «شروع تعویقی» را جلو می‌برد و
    // اشتراک کاربر هیچ‌وقت تمام نمی‌شود.
    record(5, 1, 0, { activate: true });
    await flush(env);
    const sql = db.find('first_seen')[0]!.sql;
    expect(sql).toContain('first_seen = 0');
    expect(sql).toContain('delayed_days > 0');
  });

  it('بدون activate عبارت first_seen نوشته نمی‌شود', async () => {
    record(5, 1, 0);
    await flush(env);
    expect(db.find('first_seen')).toHaveLength(0);
  });

  it('یک activate در میان چند record کافی است', async () => {
    record(5, 1, 0);
    record(5, 1, 0, { activate: true });
    record(5, 1, 0);
    await flush(env);
    expect(db.find('first_seen')).toHaveLength(1);
  });
});

describe('flush — دسته‌بندی و همزمانی', () => {
  it('دسته‌ها از سقف ۴۰ عبارت رد نمی‌شوند', async () => {
    // D1 روی Free سقف ۵۰ کوئری در هر invocation دارد؛ ۴۰ حاشیه‌ی امن است.
    for (let i = 1; i <= 100; i++) record(i, 10, 20, { ip: `10.0.0.${i}`, inboundId: 1 });
    await flush(env);
    expect(db.batchSizes.length).toBeGreaterThan(1);
    for (const n of db.batchSizes) expect(n).toBeLessThanOrEqual(40);
    // هیچ عبارتی بیرون از دسته اجرا نشده باشد.
    expect(db.log.every((x) => x.batch !== null)).toBe(true);
  });

  it('همه‌ی عبارت‌ها نوشته می‌شوند، هیچ‌کدام گم نمی‌شود', async () => {
    for (let i = 1; i <= 100; i++) record(i, 10, 20);
    await flush(env);
    expect(db.find('UPDATE clients SET up')).toHaveLength(100);
    expect(db.batchSizes.reduce((a, b) => a + b, 0)).toBe(db.log.length);
  });

  it('بعد از flush موفق، pending خالی می‌شود', async () => {
    record(1, 100, 0);
    await flush(env);
    expect(pendingOf(1)).toBe(0);
    expect(hasPending()).toBe(false);
  });

  it('flush بی‌داده کوئری نمی‌زند', async () => {
    await flush(env);
    expect(db.log).toHaveLength(0);
  });

  it('دو flush همزمان یک نوشتن می‌سازد', async () => {
    record(1, 100, 0);
    const a = flush(env);
    const b = flush(env);
    expect(a).toBe(b);
    await a;
    expect(db.find('UPDATE clients SET up')).toHaveLength(1);
  });

  it('دلتای تازه در میانه‌ی flush گم نمی‌شود', async () => {
    record(1, 100, 0);
    const p = flush(env);
    // این ثبت بعد از خالی‌شدن map ولی قبل از تمام‌شدن نوشتن می‌رسد.
    record(1, 7, 0);
    await p;
    expect(pendingOf(1)).toBe(7);
    await flush(env);
    const both = db.find('UPDATE clients SET up').map((x) => x.args[0]);
    expect(both).toEqual([100, 7]);
  });

  it('شکست نوشتن دلتاها را برمی‌گرداند', async () => {
    // اگر برنگردند، ترافیکِ مصرف‌شده از سقف کاربر کم نمی‌شود و رایگان می‌ماند.
    record(1, 100, 200, { ip: '1.1.1.1', colo: 'FRA', activate: true, at: Date.UTC(2026, 8, 4) });
    record(2, 5, 5, { inboundId: 9 });
    db.failWith = new Error('D1 down');
    await flush(env);
    expect(pendingOf(1)).toBe(300);
    expect(pendingOf(2)).toBe(10);

    db.failWith = null;
    await flush(env);
    expect(argsOf('UPDATE clients SET up')).toEqual([100, 200, Math.floor(Date.UTC(2026, 8, 4) / 1000), 1]);
    expect(db.find('client_ips')[0]!.args[1]).toBe('1.1.1.1');
    expect(db.find('first_seen')).toHaveLength(1);
    expect(argsOf('UPDATE inbounds SET up')).toEqual([5, 5, 9]);
  });

  it('دلتای برگشته با دلتای تازه ادغام می‌شود', async () => {
    record(1, 100, 0, { at: Date.UTC(2026, 8, 4) });
    db.failWith = new Error('D1 down');
    await flush(env);
    record(1, 50, 0, { at: Date.UTC(2026, 8, 4) });
    expect(pendingOf(1)).toBe(150);

    db.failWith = null;
    await flush(env);
    expect(argsOf('UPDATE clients SET up')[0]).toBe(150);
    // آمار روزانه هم باید یک ردیفِ جمع‌شده باشد، نه دو ردیف.
    expect(db.find('client_usage_daily')).toHaveLength(1);
    expect(db.find('client_usage_daily')[0]!.args[3]).toBe(150);
  });

  it('شکست پشت‌سرهم چیزی را چند برابر نمی‌کند', async () => {
    record(1, 100, 0);
    db.failWith = new Error('down');
    await flush(env);
    await flush(env);
    await flush(env);
    expect(pendingOf(1)).toBe(100);
  });

  it('last_online بزرگ‌ترین زمان را نگه می‌دارد', async () => {
    record(1, 1, 0, { at: Date.UTC(2026, 8, 4, 10) });
    record(1, 1, 0, { at: Date.UTC(2026, 8, 4, 8) });
    await flush(env);
    expect(argsOf('UPDATE clients SET up')[2]).toBe(Math.floor(Date.UTC(2026, 8, 4, 10) / 1000));
  });

  it('resetUsage همه‌چیز را پاک می‌کند', () => {
    record(1, 100, 0);
    setNodeName('x');
    resetUsage();
    expect(hasPending()).toBe(false);
    expect(pendingOf(1)).toBe(0);
  });

  it('نام نودِ خالی به local برمی‌گردد', async () => {
    setNodeName('');
    record(1, 1, 0);
    await flush(env);
    expect(db.find('client_usage_daily')[0]!.args[2]).toBe('local');
  });
});

describe('سقف ترافیک در فاصله‌ی دو flush', () => {
  it('pendingOf بایت‌های نانوشته را می‌شمارد', () => {
    // این تنها چیزی است که جلوی رد شدن از سقف را در فاصله‌ی دو flush می‌گیرد:
    // کاربر با یک نشست بزرگ می‌توانست از سقفش عبور کند و کسی نفهمد.
    const capBytes = 1024;
    record(1, 600, 0);
    expect(pendingOf(1)).toBeLessThan(capBytes);
    record(1, 500, 0);
    expect(pendingOf(1)).toBeGreaterThanOrEqual(capBytes);
  });

  it('بعد از flush صفر می‌شود چون در D1 نوشته شده', async () => {
    record(1, 1000, 0);
    await flush(env);
    // از این به بعد سقف از مقدار خودِ ردیف می‌آید، پس دو بار شمردن غلط است.
    expect(pendingOf(1)).toBe(0);
  });

  it('بعد از شکستِ نوشتن، همچنان شمرده می‌شود', async () => {
    record(1, 1000, 0);
    db.failWith = new Error('down');
    await flush(env);
    expect(pendingOf(1)).toBe(1000);
  });
});

