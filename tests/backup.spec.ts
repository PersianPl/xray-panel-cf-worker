/**
 * تست بکاپ/ریستور — ساختار خروجی، اعتبارسنجی ورودی، یکپارچگی FK، و رعایت
 * سقف‌های D1 (≤ ۱۰۰ پارامتر در عبارت، دسته‌بندی ≤ ۴۰).
 */
import { describe, expect, it } from 'vitest';
import { APP_NAME, exportBackup, restoreBackup } from '../src/panel/backup';
import { FakeD1, fakeEnv } from './stubs/d1';
import type { Env } from '../src/types';

function env(db: FakeD1): Env {
  return fakeEnv(db) as unknown as Env;
}

const INBOUND = { id: 1, tag: 'main', remark: '', enable: 1, protocol: 'vless', transport: 'ws', path: '/ws', host: '', sni: '', ports: '[443]', max_early_data: 2560, ss_method: 'aes-128-gcm', vmess_security: 'auto', total_gb: 0, traffic_reset: 'never', last_reset_at: 0, expiry_at: 0, up: 5, down: 7, extra: '{}', created_at: 100 };
const CLIENT = { id: 1, inbound_id: 1, name: 'ali', comment: '', auth: 'u-1', enable: 1, total_gb: 10, up: 1, down: 2, expiry_at: 0, delayed_days: 0, renew_days: 0, reset_count: 0, limit_ip: 0, sub_token: 'tok', tg_chat_id: '', pref_node: '', proxyip: '', nat64_prefix: '', routing_id: null, gen_opts: '{}', last_online: 0, first_seen: 0, created_at: 100 };

describe('exportBackup', () => {
  it('همه‌ی جدول‌ها را با ساختار درست جمع می‌کند', async () => {
    const db = new FakeD1();
    db.onQuery((sql) => {
      if (sql.startsWith('SELECT k, v FROM settings')) return [{ k: 'theme', v: 'dark' }];
      if (sql.includes('FROM inbounds')) return [INBOUND];
      if (sql.includes('FROM clients')) return [CLIENT];
      return null;
    });
    const out = await exportBackup(env(db));
    expect(out.version).toBe(1);
    expect(out.app).toBe(APP_NAME);
    expect(out.settings.theme).toBe('dark');
    expect(out.inbounds[0]!.tag).toBe('main');
    expect(out.clients[0]!.name).toBe('ali');
    expect(Array.isArray(out.nodes)).toBe(true);
    expect(Array.isArray(out.api_keys)).toBe(true);
  });
});

describe('restoreBackup', () => {
  function backup(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      version: 1, app: APP_NAME, at: 100,
      settings: { theme: 'dark', panel_path: 'pnl' },
      inbounds: [INBOUND],
      clients: [CLIENT],
      nodes: [], routing_profiles: [], api_keys: [],
      ...over,
    };
  }

  it('ریستور موفق — یک دسته‌ی اتمیک، ترتیب درست، حفظ ID', async () => {
    const db = new FakeD1();
    const out = await restoreBackup(env(db), backup());
    expect(out).toEqual({
      ok: true,
      restored: { settings: 2, inbounds: 1, clients: 1, nodes: 0, routing_profiles: 0, api_keys: 0 },
    });
    // همه در یک دسته (اتمیک کامل)
    expect(db.batchSizes).toEqual([db.batchSizes[0]]);
    const all = db.log;
    // اول پاک‌سازی، بعد درج با ID صریح
    expect(all[0]!.sql).toBe('DELETE FROM clients');
    const firstIns = all.find((e) => e.sql.startsWith('INSERT INTO inbounds'))!;
    expect(firstIns.sql).toContain('VALUES (?,');
    expect(firstIns.args[0]).toBe(1);
    // تنظیمات: حذف + درج چندردیفی
    expect(db.find('DELETE FROM settings').length).toBe(1);
    expect(db.find('INSERT INTO settings').length).toBeGreaterThanOrEqual(1);
  });

  it('فایل بیگانه رد می‌شود', async () => {
    const db = new FakeD1();
    const out = await restoreBackup(env(db), backup({ version: 2 }));
    expect(out.ok).toBe(false);
    expect(db.log.length).toBe(0);
  });

  it('FK شکسته → رد، بدون هیچ نوشتنی', async () => {
    const db = new FakeD1();
    const out = await restoreBackup(env(db), backup({ clients: [{ ...CLIENT, inbound_id: 99 }] }));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('inbound ناموجود');
    expect(db.log.length).toBe(0);
  });

  it('فیلد ضروری جاافتاده → رد', async () => {
    const db = new FakeD1();
    const bad = { ...CLIENT } as Record<string, unknown>;
    delete bad.auth;
    const out = await restoreBackup(env(db), backup({ clients: [bad] }));
    expect(out.ok).toBe(false);
  });

  it('پنل بزرگ — سقف پارامتر و دسته‌بندی رعایت می‌شود', async () => {
    const db = new FakeD1();
    const clients = Array.from({ length: 200 }, (_, i) => ({ ...CLIENT, id: i + 1, name: `u${i}` }));
    const out = await restoreBackup(env(db), backup({ clients }));
    expect(out.ok).toBe(true);
    // بیش از ۴۵ عبارت → چند دسته، هر دسته ≤ ۴۰ عبارت
    expect(db.batchSizes.length).toBeGreaterThan(1);
    for (const n of db.batchSizes) expect(n).toBeLessThanOrEqual(40);
    // هیچ عبارتی بیش از ۱۰۰ پارامتر ندارد
    for (const e of db.log) expect(e.args.length).toBeLessThanOrEqual(100);
  });
});
