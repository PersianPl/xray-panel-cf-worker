/**
 * API نودها — پنل کانفیگ می‌دهد و آمار می‌گیرد.
 *
 * مسیرها (همه زیر `/api/node`):
 *   • `GET  /config`  → کانفیگ کامل نود (کاربران + تنظیمات خروجی)، با ETag
 *   • `POST /stats`   → دلتای مصرف کاربران روی آن نود
 *   • `POST /hello`   → اعلام حضور و گزارش سلامت
 *
 * احراز هویت با **HMAC-SHA256** روی خودِ بدنه/مسیر، نه با توکن خام در هدر:
 *   `Authorization: PPL <node-name>:<hex-hmac>`
 *   hmac = HMAC(node_secret, `${method}\n${path}\n${timestamp}\n${bodyHash}`)
 * چرا: توکن خام در لاگ‌های میانی می‌نشیند و اگر لو برود قابل استفاده‌ی نامحدود
 * است؛ امضا با timestamp پنجره‌ی محدود دارد (±۳۰۰ ثانیه) و بدنه را هم مقید
 * می‌کند، پس replay با بدنه‌ی دیگر ممکن نیست.
 */
import { hmacSign, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { invalidateSettings, type Settings } from '../lib/settings';
import { utcDay } from '../lib/usage';
import { invalidateClients } from '../proxy/store';
import type { Env } from '../types';

/** پنجره‌ی مجاز اختلاف ساعت با پنل. */
const SKEW_SEC = 300;
/** سقف تعداد ردیف آمار در یک push (جلوگیری از سوءاستفاده). */
const MAX_STAT_ROWS = 500;

export async function handleNodeApi(
  req: Request,
  env: Env,
  s: Settings,
  seg: string[],
  ctx: ExecutionContext,
): Promise<Response> {
  const action = seg[0] ?? '';
  const secret = s.get('node_secret');
  if (!secret) return json({ error: 'node API غیرفعال است' }, 503);

  const body = req.method === 'GET' ? '' : await req.text();
  const auth = await verify(req, env, secret, body);
  if (!auth.ok) return json({ error: auth.reason }, 401);

  switch (action) {
    case 'config':
      return nodeConfig(env, s, req, auth.node);
    case 'stats':
      return nodeStats(env, body, auth.node, ctx);
    case 'hello':
      return nodeHello(env, body, auth.node);
    default:
      return json({ error: 'مسیر ناشناس' }, 404);
  }
}

interface AuthOk {
  ok: true;
  node: string;
}
type AuthResult = AuthOk | { ok: false; reason: string };

/** امضا را می‌سنجد: نام نود + HMAC روی متد/مسیر/زمان/هش بدنه. */
async function verify(req: Request, env: Env, secret: string, body: string): Promise<AuthResult> {
  const header = req.headers.get('authorization') ?? '';
  const m = /^PPL\s+([A-Za-z0-9._-]{1,64}):([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: 'هدر Authorization نامعتبر' };
  const [, node, sig] = m as unknown as [string, string, string];

  const ts = Number(req.headers.get('x-ppl-ts') ?? '0');
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SKEW_SEC) {
    return { ok: false, reason: 'timestamp خارج از بازه' };
  }

  const row = await env.DB.prepare('SELECT name FROM nodes WHERE name = ? AND enable = 1').bind(node).first<{ name: string }>();
  if (!row) return { ok: false, reason: 'نود ناشناس یا غیرفعال' };

  const url = new URL(req.url);
  const payload = `${req.method}\n${url.pathname}\n${ts}\n${await sha256Hex(body)}`;
  // کلید هر نود مخصوص خودش است: HMAC(node_secret, name) — لو رفتن یک نود بقیه
  // را باز نمی‌کند.
  const key = await hmacSign(secret, `node:${node}`);
  const want = await hmacSign(key, payload);
  if (!timingSafeEqual(want, sig)) return { ok: false, reason: 'امضا نامعتبر' };
  return { ok: true, node };
}

/** کلید مخصوص یک نود — همان چیزی که در تنظیمات نود گذاشته می‌شود. */
export async function nodeKey(secret: string, node: string): Promise<string> {
  return hmacSign(secret, `node:${node}`);
}

/**
 * کانفیگ نود: هرچه نود برای سرو کردن ترافیک لازم دارد و **هیچ چیز بیشتر**.
 * رمز ادمین، توکن ساب، آمار و تنظیمات پنل فرستاده نمی‌شوند — نود روی اکانت
 * دیگری است و باید حداقل دانش را داشته باشد.
 */
async function nodeConfig(env: Env, s: Settings, req: Request, node: string): Promise<Response> {
  const [clients, inbounds, nodeRow] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.inbound_id, c.name, c.auth, c.enable, c.total_gb, c.up, c.down,
              c.expiry_at, c.limit_ip, c.proxyip, c.nat64_prefix, c.pref_node
         FROM clients c JOIN inbounds i ON i.id = c.inbound_id
        WHERE i.enable = 1 AND (c.pref_node = '' OR c.pref_node = ?)`,
    )
      .bind(node)
      .all<Record<string, unknown>>(),
    env.DB.prepare('SELECT id, tag, protocol, transport, path, enable, max_early_data, vmess_security, ss_method FROM inbounds WHERE enable = 1').all<
      Record<string, unknown>
    >(),
    env.DB.prepare('SELECT proxyip FROM nodes WHERE name = ?').bind(node).first<{ proxyip: string }>(),
  ]);

  const payload = {
    version: 1,
    at: Math.floor(Date.now() / 1000),
    node,
    inbounds: inbounds.results ?? [],
    clients: clients.results ?? [],
    net: {
      // proxyip نود بر تنظیم سراسری مقدم است (هر نود مسیر خروجی خودش را دارد).
      proxyip: (nodeRow?.proxyip ?? '').trim() || s.get('proxyip'),
      proxyip_mode: s.get('proxyip_mode'),
      nat64_prefixes: s.get('nat64_prefixes'),
      dial_parallel: s.int('dial_parallel', 1),
      dial_timeout: s.int('dial_timeout', 2500),
      idle_timeout: s.int('idle_timeout', 100_000),
      ip_limit_enable: s.bool('ip_limit_enable'),
      kill_switch: s.bool('kill_switch'),
      pull_interval: s.int('node_pull_interval', 300),
    },
  };

  const text = JSON.stringify(payload);
  // ETag روی محتوا (بدون `at`) تا نودی که تغییری ندیده بدنه را دوباره نگیرد.
  const etag = `"${(await sha256Hex(JSON.stringify({ ...payload, at: 0 }))).slice(0, 32)}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  await env.DB.prepare('UPDATE nodes SET last_seen = ?, health = ? WHERE name = ?')
    .bind(Math.floor(Date.now() / 1000), 'ok', node)
    .run();

  return new Response(text, {
    headers: { 'content-type': 'application/json; charset=utf-8', etag, 'cache-control': 'no-store' },
  });
}

interface StatRow {
  id: number;
  up: number;
  down: number;
  last?: number;
  ips?: string[];
}

/** دلتای مصرف از نود. جمع‌بستنی است (`up = up + ?`) پس تکرار یک push فقط اضافه می‌کند. */
async function nodeStats(env: Env, body: string, node: string, ctx: ExecutionContext): Promise<Response> {
  let rows: StatRow[];
  try {
    const parsed = JSON.parse(body) as { rows?: StatRow[]; req_today?: number };
    rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    if (typeof parsed.req_today === 'number') {
      ctx.waitUntil(
        env.DB.prepare('UPDATE nodes SET req_today = ?, last_seen = ? WHERE name = ?')
          .bind(Math.max(0, Math.floor(parsed.req_today)), Math.floor(Date.now() / 1000), node)
          .run()
          .then(() => undefined),
      );
    }
  } catch {
    return json({ error: 'بدنه‌ی JSON نامعتبر' }, 400);
  }
  if (rows.length > MAX_STAT_ROWS) return json({ error: `بیش از ${MAX_STAT_ROWS} ردیف` }, 413);

  const day = utcDay();
  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];

  for (const r of rows) {
    const id = Number(r.id);
    const up = Math.max(0, Math.floor(Number(r.up) || 0));
    const down = Math.max(0, Math.floor(Number(r.down) || 0));
    if (!Number.isInteger(id) || id <= 0 || (up === 0 && down === 0)) continue;
    const last = Number.isFinite(r.last) ? Math.floor(r.last!) : now;

    stmts.push(
      env.DB.prepare('UPDATE clients SET up = up + ?, down = down + ?, last_online = MAX(last_online, ?) WHERE id = ?').bind(
        up,
        down,
        last,
        id,
      ),
      env.DB.prepare(
        'INSERT INTO client_usage_daily (client_id, day, node, up, down) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(client_id, day, node) DO UPDATE SET up = up + excluded.up, down = down + excluded.down',
      ).bind(id, day, node, up, down),
    );

    for (const ip of (r.ips ?? []).slice(0, 8)) {
      if (typeof ip !== 'string' || ip.length > 45) continue;
      stmts.push(
        env.DB.prepare(
          'INSERT INTO client_ips (client_id, ip, colo, last_seen) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(client_id, ip) DO UPDATE SET last_seen = excluded.last_seen',
        ).bind(id, ip, node, last),
      );
    }
  }

  // دسته‌بندی با فاصله از سقف ۵۰ کوئریِ D1.
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40));
  }
  return json({ ok: true, applied: rows.length });
}

async function nodeHello(env: Env, body: string, node: string): Promise<Response> {
  let health = 'ok';
  try {
    const p = JSON.parse(body) as { health?: string };
    if (p.health === 'ok' || p.health === 'stale' || p.health === 'down') health = p.health;
  } catch {
    /* بدنه‌ی خالی مجاز است */
  }
  await env.DB.prepare('UPDATE nodes SET last_seen = ?, health = ? WHERE name = ?')
    .bind(Math.floor(Date.now() / 1000), health, node)
    .run();
  // کش نود ممکن است کهنه باشد؛ اعلام حضور فرصت خوبی برای تازه‌سازی است.
  invalidateClients();
  invalidateSettings();
  return json({ ok: true, at: Math.floor(Date.now() / 1000) });
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
