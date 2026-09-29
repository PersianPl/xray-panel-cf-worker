/**
 * تست ربات تلگرام — بایند با API Key، گیتِ secret وب‌هوک، سکوت چت ناشناس،
 * و اکشن‌های دکمه‌ای.
 *
 * فراخوانی‌های api.telegram.org با stub کردن `fetch` سراسری ضبط می‌شوند تا
 * هم پیام‌ها بررسی شوند و هم هیچ درخواست واقعی بیرون نرود.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, Settings } from '../src/lib/settings';
import { sha256Hex } from '../src/lib/crypto';
import { handleTgWebhook } from '../src/tg/bot';
import { FakeD1, fakeEnv } from './stubs/d1';
import type { Env } from '../src/types';

const SEC = 'test-webhook-secret';
const CHAT = 111;
const KEY = 'pplk_testkey_abcdefgh';

function conf(over: Record<string, string> = {}): Settings {
  return new Settings(
    new Map(Object.entries({ ...DEFAULTS, tg_bot_token: 'TOK', tg_webhook_secret: SEC, ...over })),
  );
}

/** پیام‌های ارسالی به API تلگرام (method + بدنه). */
const sent: Array<{ method: string; body: Record<string, unknown> }> = [];

function stubTg(): void {
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      sent.push({
        method: url.split('/').pop() ?? '',
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ ok: true, result: { username: 'mybot' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function webhook(req: Request, db: FakeD1, s: Settings, secret: string): Promise<Response> {
  const env = fakeEnv(db) as unknown as Env;
  return handleTgWebhook(req, env, s, secret);
}

function msgReq(text: string, chatId = CHAT, secret = SEC): Request {
  return new Request(`https://panel.example.com/panel/api/telegram/webhook/${secret}`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { chat: { id: chatId, first_name: 'Ali' }, text } }),
  });
}

function cbReq(data: string, chatId = CHAT): Request {
  return new Request(`https://panel.example.com/panel/api/telegram/webhook/${SEC}`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': SEC, 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query: { id: 'cb1', data, message: { chat: { id: chatId } } } }),
  });
}

describe('وب‌هوک — احراز', () => {
  it('secret اشتباه در مسیر → ۴۰۳ و بدون هیچ پیام', async () => {
    stubTg();
    const db = new FakeD1();
    const res = await webhook(msgReq('/status', CHAT, 'wrong'), db, conf(), 'wrong');
    expect(res.status).toBe(403);
    expect(sent.length).toBe(0);
  });

  it('هدر secret تلگرام غلط → ۴۰۳', async () => {
    stubTg();
    const db = new FakeD1();
    const req = new Request(`https://x/panel/api/telegram/webhook/${SEC}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'bad', 'content-type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: CHAT }, text: '/status' } }),
    });
    const res = await webhook(req, db, conf(), SEC);
    expect(res.status).toBe(403);
    expect(sent.length).toBe(0);
  });

  it('اگر secret در تنظیمات نباشد همه‌چیز ۴۰۳ است', async () => {
    stubTg();
    const db = new FakeD1();
    const res = await webhook(msgReq('/status'), db, conf({ tg_webhook_secret: '' }), SEC);
    expect(res.status).toBe(403);
  });
});

describe('بایند با API Key', () => {
  it('/start با کلید معتبر → بایند، مصرف کلید، پیام خوش‌آمد', async () => {
    stubTg();
    const db = new FakeD1();
    const hash = await sha256Hex(KEY);
    db.onQuery((sql, args) => (sql.includes('FROM api_keys') && args[0] === hash ? { id: 7, scope: 'tg' } : null));
    const res = await webhook(msgReq(`/start ${KEY}`), db, conf({ tg_bound_chat: '' }), SEC);
    expect(res.status).toBe(200);
    // چت بایند شد…
    const bind = db.find('INSERT INTO settings').find((e) => e.args.includes('tg_bound_chat'));
    expect(bind).toBeTruthy();
    expect(bind!.args).toContain(String(CHAT));
    // …کلید مصرف شد…
    expect(db.find('DELETE FROM api_keys').length).toBe(1);
    // …و پیام خوش‌آمد رفت.
    expect(sent.find((x) => x.method === 'sendMessage')?.body.text).toContain('متصل شد');
  });

  it('/start با کلید نامعتبر → پیام خطا، بدون بایند', async () => {
    stubTg();
    const db = new FakeD1();
    db.onQuery(() => null);
    await webhook(msgReq('/start nope'), db, conf({ tg_bound_chat: '' }), SEC);
    expect(sent.find((x) => x.method === 'sendMessage')?.body.text).toContain('کلید نامعتبر');
    expect(db.find('tg_bound_chat').length).toBe(0);
  });

  it('وقتی چت دیگری بایند است، بایند دوم رد می‌شود', async () => {
    stubTg();
    const db = new FakeD1();
    db.onQuery(() => ({ id: 7, scope: 'tg' }));
    await webhook(msgReq(`/start ${KEY}`, 999), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    expect(sent[0]!.body.text).toContain('از قبل متصل');
    expect(db.find('DELETE FROM api_keys').length).toBe(0);
  });
});

describe('دستورها', () => {
  it('چت ناشناس بی‌صدا نادیده گرفته می‌شود (هیچ پیام و نوشتنی)', async () => {
    stubTg();
    const db = new FakeD1();
    await webhook(msgReq('/status', 999), db, conf(), SEC);
    expect(sent.length).toBe(0);
    expect(db.log.length).toBe(0);
  });

  it('/status از چت بایندشده → خلاصه‌ی وضعیت', async () => {
    stubTg();
    const db = new FakeD1();
    db.onQuery((sql) =>
      sql.includes('COUNT(*) AS total')
        ? { total: 2, active: 1, disabled: 0, expired: 0, depleted: 0, online: 1, up: 10, down: 20 }
        : null,
    );
    await webhook(msgReq('/status'), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    const m = sent.find((x) => x.method === 'sendMessage');
    expect(m?.body.text).toContain('وضعیت پنل');
  });

  it('/kill on → kill_switch در تنظیمات', async () => {
    stubTg();
    const db = new FakeD1();
    await webhook(msgReq('/kill on'), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    const up = db.find('INSERT INTO settings').find((e) => e.args.includes('kill_switch'));
    expect(up).toBeTruthy();
    expect(up!.args).toContain('1');
    expect(sent[0]!.body.text).toContain('Kill Switch');
  });

  it('/add کاربر می‌سازد و لینک ساب می‌دهد', async () => {
    stubTg();
    const db = new FakeD1();
    db.onQuery((sql) => (sql.includes('FROM inbounds WHERE enable = 1') ? { id: 1, protocol: 'vless' } : null));
    await webhook(msgReq('/add ali 30 50'), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    const ins = db.find('INSERT INTO clients')[0]!;
    expect(ins.args).toContain('ali');
    expect(ins.args).toContain(50); // گیگ
    // انقضا = «الان» + ۳۰ روز (حدوداً — نه عدد ثابت)
    const expiry = ins.args[4] as number;
    const now = Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThan(now + 29 * 86400);
    expect(expiry).toBeLessThan(now + 31 * 86400);
    const m = sent.find((x) => x.method === 'sendMessage');
    expect(m?.body.text).toContain('ساخته شد');
    expect(m?.body.text).toContain('/sub/');
  });
});

describe('کال‌بک‌ها (دکمه‌های شیشه‌ای)', () => {
  it('t:1 → toggle وضعیت کاربر', async () => {
    stubTg();
    const db = new FakeD1();
    db.onQuery((sql, args) => (sql.includes('JOIN inbounds i') && args[0] === 1 ? { id: 1, name: 'ali', enable: 1, total_gb: 0, up: 5, down: 5, expiry_at: 0 } : null));
    await webhook(cbReq('t:1'), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    const upd = db.find('UPDATE clients SET enable')[0]!;
    expect(upd.args[0]).toBe(0); // از روشن به خاموش
    expect(upd.args[1]).toBe(1);
    expect(sent.find((x) => x.method === 'answerCallbackQuery')).toBeTruthy();
  });

  it('r:1 → ریست مصرف', async () => {
    stubTg();
    const db = new FakeD1();
    await webhook(cbReq('r:1'), db, conf({ tg_bound_chat: String(CHAT) }), SEC);
    expect(db.find('UPDATE clients SET up = 0, down = 0').length).toBe(1);
  });
});
