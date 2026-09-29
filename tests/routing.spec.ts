/**
 * پروفایل‌های مسیریابی: CRUD + اورلی قواعد روی خروجی ساب.
 */
import { describe, expect, it } from 'vitest';
import { createProfile, listProfiles, resolveProfileRules, deleteProfile } from '../src/panel/routing';
import { FakeD1, fakeEnv } from './stubs/d1';

describe('routing profiles — CRUD', () => {
  it('ساخت: نام تمیز می‌شود و قواعد پاک‌سازی می‌شوند', async () => {
    const db = new FakeD1();
    const p = await createProfile(fakeEnv(db) as never, '  کاربران VIP  ', {
      bypass_iran: false,
      block_ads: true,
      dns_remote: 'https://dns.google/dns-query',
      direct: 'example.com\nip:1.2.3.0/24\n\n',
      proxy: 'openai.com',
      // این‌ها باید دور ریخته شوند:
      bypass_lan: 'yes' as never,
      dns_local: { bad: 'type' } as never,
    });
    expect(p.name).toBe('کاربران VIP');
    const stored = db.find('INSERT INTO routing_profiles')[0]!;
    const rules = JSON.parse(stored.args[1] as string);
    expect(rules.bypass_iran).toBe(false);
    expect(rules.block_ads).toBe(true);
    expect(rules.dns_remote).toBe('https://dns.google/dns-query');
    expect(rules.direct).toBe('example.com\nip:1.2.3.0/24');
    expect(rules.proxy).toBe('openai.com');
    expect(rules.bypass_lan).toBeUndefined();
    expect(rules.dns_local).toBeUndefined();
  });

  it('نام خالی → خطا', async () => {
    const db = new FakeD1();
    await expect(createProfile(fakeEnv(db) as never, '   ', {})).rejects.toThrow();
  });

  it('فهرست با شمارش کلاینت‌ها', async () => {
    const db = new FakeD1();
    db.onQuery((_sql, _args) => [
      { id: 1, name: 'a', is_default: 1, rules: '{}', created_at: 1, clients: 3 },
      { id: 2, name: 'b', is_default: 0, rules: '{"block_ads":true}', created_at: 2, clients: 0 },
    ]);
    const list = await listProfiles(fakeEnv(db) as never);
    expect(list.length).toBe(2);
    expect(list[0]!.clients).toBe(3);
    expect(list[1]!.rules.block_ads).toBe(true);
  });

  it('حذف پروفایل: مرجع کلاینت‌ها هم آزاد می‌شود', async () => {
    const db = new FakeD1();
    const { deleteProfile } = await import('../src/panel/routing');
    await deleteProfile(fakeEnv(db) as never, 7);
    const upd = db.find('UPDATE clients SET routing_id = NULL')[0]!;
    expect(upd.args).toContain(7);
    expect(db.batchSizes).toContain(2);
  });
});

describe('routing — resolve و اورلی روی ساب', () => {
  it('قواعد پروفایل خوانده و باز می‌گردند', async () => {
    const db = new FakeD1();
    db.onQuery(() => ({ rules: '{"bypass_iran":false,"direct":"a.com"}' }));
    const r = await resolveProfileRules(fakeEnv(db) as never, 5);
    expect(r).toEqual({ bypass_iran: false, direct: 'a.com' });
    expect(db.find('WHERE id = ?')[0]!.args).toContain(5);
  });

  it('پروفایل نبود → null (قواعد عمومی اعمال می‌شود)', async () => {
    const db = new FakeD1();
    db.onQuery(() => null);
    expect(await resolveProfileRules(fakeEnv(db) as never, 9)).toBeNull();
  });
});
