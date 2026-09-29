/**
 * تست پروتکل نود ↔ پنل.
 *
 * نکته‌ی اصلی: امضا در **دو فایل جدا** ساخته و بررسی می‌شود
 * ([node/worker.ts](../src/node/worker.ts) و [node/api.ts](../src/node/api.ts)).
 * اگر قالب payload در یکی عوض شود، تستی که فقط یک طرف را بسنجد سبز می‌ماند و
 * بعدش همه‌ی نودها با هم ۴۰۱ می‌گیرند — یعنی کل ترافیک روی نودها می‌خوابد. پس
 * اینجا خروجی سمت نود مستقیم به ورودی سمت پنل داده می‌شود.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNodeApi, nodeKey } from '../src/node/api';
import { signHeaders } from '../src/node/worker';
import { DEFAULTS, Settings, invalidateSettings } from '../src/lib/settings';
import { resetUsage } from '../src/lib/usage';
import { invalidateClients } from '../src/proxy/store';
import { FakeCtx, FakeD1 } from './stubs/d1';
import type { Env } from '../src/types';

const SECRET = 'node-secret-for-test';
const NODE = 'de-1';

const db = new FakeD1();
const env = { DB: db } as unknown as Env;

/** تنظیمات با `node_secret` پر. */
function conf(over: Record<string, string> = {}): Settings {
  return new Settings(new Map([...Object.entries(DEFAULTS), ['node_secret', SECRET], ...Object.entries(over)]));
}

/** پاسخ پیش‌فرض D1: نود شناخته‌شده و فعال. */
function knownNode(): void {
  db.onQuery((sql) => {
    if (sql.includes('FROM nodes WHERE name = ? AND enable = 1')) return { name: NODE };
    if (sql.includes('SELECT proxyip FROM nodes')) return { proxyip: '' };
    return [];
  });
}

afterEach(() => {
  db.reset();
  resetUsage();
  invalidateClients();
  invalidateSettings();
  vi.useRealTimers();
});

/** یک درخواست امضاشده‌ی نود، همان‌طور که `node/worker.ts` می‌سازد. */
async function signedReq(
  action: string,
  method: 'GET' | 'POST',
  body = '',
  over: { key?: string; node?: string; headers?: Record<string, string> } = {},
): Promise<Request> {
  const path = `/api/node/${action}`;
  const key = over.key ?? (await nodeKey(SECRET, over.node ?? NODE));
  const headers = { ...(await signHeaders(key, over.node ?? NODE, method, path, body)), ...(over.headers ?? {}) };
  if (method === 'POST') headers['content-type'] = 'application/json';
  return new Request(`https://panel.example.com${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
  });
}

async function call(req: Request, s = conf()): Promise<{ status: number; body: Record<string, unknown>; res: Response; ctx: FakeCtx }> {
  const ctx = new FakeCtx();
  const seg = new URL(req.url).pathname.split('/').filter(Boolean).slice(2);
  const res = await handleNodeApi(req, env, s, seg, ctx as unknown as ExecutionContext);
  await ctx.settle();
  const text = await res.clone().text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, res, ctx };
}

describe('امضای HMAC — دو سر پروتکل', () => {
  it('درخواستِ امضاشده‌ی نود از سمت پنل تأیید می‌شود', async () => {
    knownNode();
    const { status } = await call(await signedReq('hello', 'POST', '{}'));
    expect(status).toBe(200);
  });

  it('کلید هر نود مخصوص خودش است', async () => {
    // لو رفتن کلید یک نود نباید بقیه را باز کند.
    const k1 = await nodeKey(SECRET, 'n1');
    const k2 = await nodeKey(SECRET, 'n2');
    expect(k1).not.toBe(k2);
    expect(k1).toHaveLength(64);
  });

  it('کلید یک نود روی نام نود دیگر کار نمی‌کند', async () => {
    knownNode();
    const wrongKey = await nodeKey(SECRET, 'other-node');
    const { status, body } = await call(await signedReq('hello', 'POST', '{}', { key: wrongKey }));
    expect(status).toBe(401);
    expect(body.error).toBe('امضا نامعتبر');
  });

  it('secret اشتباه رد می‌شود', async () => {
    knownNode();
    const { status } = await call(await signedReq('hello', 'POST', '{}', { key: await nodeKey('wrong-secret', NODE) }));
    expect(status).toBe(401);
  });

  it('امضا بدنه را مقید می‌کند — replay با بدنه‌ی دیگر رد می‌شود', async () => {
    knownNode();
    const good = await signedReq('stats', 'POST', JSON.stringify({ rows: [{ id: 1, up: 10, down: 10 }] }));
    // همان هدرها، بدنه‌ی متفاوت: عملاً «مصرف کاربر را صفر کن».
    const tampered = new Request(good.url, {
      method: 'POST',
      headers: good.headers,
      body: JSON.stringify({ rows: [{ id: 1, up: 999999, down: 0 }] }),
    });
    expect((await call(tampered)).status).toBe(401);
  });

  it('امضا به متد و مسیر مقید است', async () => {
    knownNode();
    const s = await signHeaders(await nodeKey(SECRET, NODE), NODE, 'GET', '/api/node/config', '');
    // همان امضا روی مسیر دیگر.
    const req = new Request('https://panel.example.com/api/node/stats', { method: 'POST', headers: { ...s }, body: '' });
    expect((await call(req)).status).toBe(401);
  });

  it('timestamp قدیمی‌تر از ۳۰۰ ثانیه رد می‌شود', async () => {
    knownNode();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    const req = await signedReq('hello', 'POST', '{}');
    vi.setSystemTime(new Date('2026-09-04T00:05:01Z'));
    const { status, body } = await call(req);
    expect(status).toBe(401);
    expect(body.error).toBe('timestamp خارج از بازه');
  });

  it('timestamp داخل بازه پذیرفته می‌شود', async () => {
    knownNode();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    const req = await signedReq('hello', 'POST', '{}');
    vi.setSystemTime(new Date('2026-09-04T00:04:59Z'));
    expect((await call(req)).status).toBe(200);
  });

  it('timestamp آینده هم محدود است (ساعت نود جلو باشد)', async () => {
    knownNode();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:10:00Z'));
    const req = await signedReq('hello', 'POST', '{}');
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    expect((await call(req)).status).toBe(401);
  });

  it('هدر Authorization بدفرم رد می‌شود', async () => {
    knownNode();
    const bad = [
      '',
      'Bearer abc',
      `PPL ${NODE}`,
      `PPL ${NODE}:short`,
      `PPL ${NODE}:${'z'.repeat(64)}`, // خارج از hex
      `PPL bad name:${'a'.repeat(64)}`,
      `PPL ${'n'.repeat(65)}:${'a'.repeat(64)}`,
    ];
    for (const authorization of bad) {
      const req = new Request('https://panel.example.com/api/node/hello', {
        method: 'POST',
        headers: { authorization, 'x-ppl-ts': String(Math.floor(Date.now() / 1000)) },
        body: '{}',
      });
      const { status, body } = await call(req);
      expect(status, authorization).toBe(401);
      expect(body.error, authorization).toBe('هدر Authorization نامعتبر');
    }
  });

  it('هدر x-ppl-ts غایب یا غیرعددی رد می‌شود', async () => {
    knownNode();
    for (const ts of [undefined, 'abc', '', 'NaN']) {
      const good = await signedReq('hello', 'POST', '{}');
      const headers = new Headers(good.headers);
      if (ts === undefined) headers.delete('x-ppl-ts');
      else headers.set('x-ppl-ts', ts);
      const req = new Request(good.url, { method: 'POST', headers, body: '{}' });
      expect((await call(req)).status, String(ts)).toBe(401);
    }
  });

  it('نود ناشناس یا غیرفعال رد می‌شود', async () => {
    db.onQuery(() => null);
    const { status, body } = await call(await signedReq('hello', 'POST', '{}'));
    expect(status).toBe(401);
    expect(body.error).toBe('نود ناشناس یا غیرفعال');
  });

  it('بدون node_secret کل API خاموش است', async () => {
    knownNode();
    const { status, body } = await call(await signedReq('hello', 'POST', '{}'), conf({ node_secret: '' }));
    expect(status).toBe(503);
    expect(body.error).toContain('غیرفعال');
  });

  it('بدون secret حتی امضای درست هم جواب نمی‌گیرد', async () => {
    knownNode();
    const { status } = await call(await signedReq('config', 'GET'), conf({ node_secret: '' }));
    expect(status).toBe(503);
  });

  it('مسیر ناشناس بعد از احراز ۴۰۴ می‌دهد', async () => {
    knownNode();
    const { status } = await call(await signedReq('unknown-action', 'POST', '{}'));
    expect(status).toBe(404);
  });
});

describe('GET config', () => {
  /** پاسخ D1 برای یک پنل با یک inbound و دو کاربر. */
  function withData(over: { clients?: unknown[]; proxyip?: string } = {}): void {
    db.onQuery((sql) => {
      if (sql.includes('FROM nodes WHERE name = ? AND enable = 1')) return { name: NODE };
      if (sql.includes('SELECT proxyip FROM nodes')) return { proxyip: over.proxyip ?? '' };
      if (sql.includes('FROM inbounds WHERE enable = 1')) {
        return [{ id: 1, tag: 'vl', protocol: 'vless', transport: 'ws', path: '/t', enable: 1, max_early_data: 2560 }];
      }
      if (sql.includes('FROM clients c JOIN inbounds')) {
        return over.clients ?? [{ id: 10, inbound_id: 1, name: 'ali', auth: 'u-1', enable: 1 }];
      }
      return [];
    });
  }

  it('کاربران و inboundها و تنظیمات شبکه برمی‌گردند', async () => {
    withData();
    const { status, body } = await call(await signedReq('config', 'GET'));
    expect(status).toBe(200);
    expect(body.node).toBe(NODE);
    expect(body.version).toBe(1);
    expect((body.clients as unknown[])[0]).toMatchObject({ id: 10, name: 'ali' });
    expect((body.inbounds as unknown[])[0]).toMatchObject({ protocol: 'vless', path: '/t' });
    expect(body.net).toMatchObject({ proxyip_mode: 'proxyip', dial_timeout: 2500, pull_interval: 300 });
  });

  it('هیچ داده‌ی حساسی در کانفیگ نود نیست', async () => {
    // نود روی اکانت کلادفلر دیگری است؛ رمز ادمین، توکن ساب و توکن تلگرام
    // نباید از پنل بیرون بروند.
    withData();
    const { res } = await call(await signedReq('config', 'GET'));
    const text = await res.text();
    for (const bad of ['sub_token', 'admin_pass', 'pass_hash', 'tg_bot_token', 'node_secret', SECRET]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it('proxyip نود بر تنظیم سراسری مقدم است', async () => {
    withData({ proxyip: '9.9.9.9' });
    const { body } = await call(await signedReq('config', 'GET'), conf({ proxyip: '1.1.1.1' }));
    expect((body.net as Record<string, unknown>).proxyip).toBe('9.9.9.9');
  });

  it('proxyip خالی نود به تنظیم سراسری برمی‌گردد', async () => {
    withData({ proxyip: '  ' });
    const { body } = await call(await signedReq('config', 'GET'), conf({ proxyip: '1.1.1.1' }));
    expect((body.net as Record<string, unknown>).proxyip).toBe('1.1.1.1');
  });

  it('ETag برمی‌گردد و last_seen به‌روز می‌شود', async () => {
    withData();
    const { res } = await call(await signedReq('config', 'GET'));
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(db.find('UPDATE nodes SET last_seen')).toHaveLength(1);
  });

  it('ETag یکسان با محتوای یکسان (فقط زمان عوض شده)', async () => {
    withData();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    const a = (await call(await signedReq('config', 'GET'))).res.headers.get('etag');
    vi.setSystemTime(new Date('2026-09-04T00:01:00Z'));
    const b = (await call(await signedReq('config', 'GET'))).res.headers.get('etag');
    expect(b).toBe(a);
  });

  it('ETag با تغییر کاربران عوض می‌شود', async () => {
    withData();
    const a = (await call(await signedReq('config', 'GET'))).res.headers.get('etag');
    withData({ clients: [{ id: 11, inbound_id: 1, name: 'reza', auth: 'u-2', enable: 1 }] });
    const b = (await call(await signedReq('config', 'GET'))).res.headers.get('etag');
    expect(b).not.toBe(a);
  });

  it('if-none-match مطابق → ۳۰۴ بدون بدنه', async () => {
    withData();
    const first = await call(await signedReq('config', 'GET'));
    const etag = first.res.headers.get('etag')!;
    const req = await signedReq('config', 'GET', '', { headers: { 'if-none-match': etag } });
    const res = await handleNodeApi(req, env, conf(), ['config'], new FakeCtx() as unknown as ExecutionContext);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('کاربرانِ مقیدشده به نود دیگر در کوئری فیلتر می‌شوند', async () => {
    withData();
    await call(await signedReq('config', 'GET'));
    const q = db.find('FROM clients c JOIN inbounds')[0]!;
    expect(q.sql).toContain("c.pref_node = '' OR c.pref_node = ?");
    expect(q.args).toEqual([NODE]);
  });
});

describe('POST stats', () => {
  it('دلتا به‌صورت جمع نوشته می‌شود', async () => {
    knownNode();
    const body = JSON.stringify({ rows: [{ id: 10, up: 100, down: 200, last: 1_756_000_000 }] });
    const { status, body: out } = await call(await signedReq('stats', 'POST', body));
    expect(status).toBe(200);
    expect(out.applied).toBe(1);
    const upd = db.find('UPDATE clients SET up')[0]!;
    expect(upd.sql).toContain('up = up + ?');
    expect(upd.args).toEqual([100, 200, 1_756_000_000, 10]);
  });

  it('آمار روزانه به نام همان نود ثبت می‌شود', async () => {
    knownNode();
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows: [{ id: 10, up: 1, down: 1 }] })));
    const row = db.find('client_usage_daily')[0]!;
    expect(row.args[2]).toBe(NODE);
  });

  it('IPها ثبت می‌شوند، حداکثر ۸ تا در هر ردیف', async () => {
    knownNode();
    const ips = Array.from({ length: 20 }, (_, i) => `10.0.0.${i}`);
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows: [{ id: 10, up: 1, down: 0, ips }] })));
    expect(db.find('client_ips')).toHaveLength(8);
  });

  it('IP بی‌ریخت یا خیلی بلند رد می‌شود', async () => {
    knownNode();
    const ips = ['1.2.3.4', 'x'.repeat(46), 123 as unknown as string, null as unknown as string];
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows: [{ id: 10, up: 1, down: 0, ips }] })));
    expect(db.find('client_ips')).toHaveLength(1);
  });

  it('ردیف با مقادیر منفی یا شناسه‌ی بی‌معنی نادیده گرفته می‌شود', async () => {
    // نود روی اکانت دیگری است و «نیمه‌مطمئن» حساب می‌شود؛ نباید بتواند با
    // عدد منفی مصرف کاربر را کم کند.
    knownNode();
    const rows = [
      { id: 10, up: -500, down: -500 },
      { id: 0, up: 10, down: 10 },
      { id: -3, up: 10, down: 10 },
      { id: 1.5, up: 10, down: 10 },
      { id: 11, up: 0, down: 0 },
    ];
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows })));
    expect(db.find('UPDATE clients SET up')).toHaveLength(0);
  });

  it('مقدار اعشاری به عدد صحیح گرد می‌شود', async () => {
    knownNode();
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows: [{ id: 10, up: 10.9, down: 5.2 }] })));
    expect(db.find('UPDATE clients SET up')[0]!.args.slice(0, 2)).toEqual([10, 5]);
  });

  it('بیش از ۵۰۰ ردیف رد می‌شود', async () => {
    knownNode();
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, up: 1, down: 1 }));
    const { status, body } = await call(await signedReq('stats', 'POST', JSON.stringify({ rows })));
    expect(status).toBe(413);
    expect(body.error).toContain('500');
    expect(db.find('UPDATE clients SET up')).toHaveLength(0);
  });

  it('دسته‌ها از سقف ۴۰ عبارت رد نمی‌شوند و هیچ عبارتی جا نمی‌افتد', async () => {
    knownNode();
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, up: 1, down: 1, ips: ['1.2.3.4'] }));
    await call(await signedReq('stats', 'POST', JSON.stringify({ rows })));
    expect(db.batchSizes.length).toBeGreaterThan(1);
    for (const n of db.batchSizes) expect(n).toBeLessThanOrEqual(40);
    // هر ردیف سه عبارت دارد (کاربر + روزانه + IP). اگر گام دسته‌بندی و اندازه‌ی
    // برش با هم نخوانند، بخشی از عبارت‌ها بی‌صدا اجرا نمی‌شوند.
    expect(db.find('UPDATE clients SET up')).toHaveLength(100);
    expect(db.find('client_usage_daily')).toHaveLength(100);
    expect(db.find('client_ips')).toHaveLength(100);
  });

  it('بدنه‌ی JSON خراب ۴۰۰ می‌دهد', async () => {
    knownNode();
    const { status, body } = await call(await signedReq('stats', 'POST', '{not json'));
    expect(status).toBe(400);
    expect(body.error).toContain('JSON');
  });

  it('بدنه‌ی بدون rows پذیرفته می‌شود و کاری نمی‌کند', async () => {
    knownNode();
    const { status } = await call(await signedReq('stats', 'POST', '{}'));
    expect(status).toBe(200);
    expect(db.find('UPDATE clients SET up')).toHaveLength(0);
  });

  it('req_today در پس‌زمینه ثبت می‌شود', async () => {
    knownNode();
    await call(await signedReq('stats', 'POST', JSON.stringify({ req_today: 4321, rows: [] })));
    expect(db.find('req_today')[0]!.args[0]).toBe(4321);
  });

  it('req_today منفی به صفر می‌رسد', async () => {
    knownNode();
    await call(await signedReq('stats', 'POST', JSON.stringify({ req_today: -5, rows: [] })));
    expect(db.find('req_today')[0]!.args[0]).toBe(0);
  });
});

describe('POST hello', () => {
  it('سلامت گزارش‌شده ثبت می‌شود', async () => {
    knownNode();
    for (const health of ['ok', 'stale', 'down']) {
      db.reset();
      knownNode();
      await call(await signedReq('hello', 'POST', JSON.stringify({ health })));
      expect(db.find('UPDATE nodes SET last_seen')[0]!.args[1], health).toBe(health);
    }
  });

  it('سلامت ناشناس به ok برمی‌گردد', async () => {
    knownNode();
    await call(await signedReq('hello', 'POST', JSON.stringify({ health: 'weird' })));
    expect(db.find('UPDATE nodes SET last_seen')[0]!.args[1]).toBe('ok');
  });

  it('بدنه‌ی خالی مجاز است', async () => {
    knownNode();
    const { status, body } = await call(await signedReq('hello', 'POST', ''));
    expect(status).toBe(200);
    expect(typeof body.at).toBe('number');
  });
});

