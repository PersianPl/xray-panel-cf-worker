/**
 * مدیریت نودها + ویزارد افزودن نود.
 *
 * توکن نود **هرگز** خام ذخیره نمی‌شود: کلید هر نود از `HMAC(node_secret, "node:"+name)`
 * مشتق می‌شود، پس با دانستن `node_secret` می‌توان بازتولیدش کرد و لازم نیست
 * جایی بنشیند. `token_hash` فقط برای نمایش «آیا توکن صادر شده» است.
 *
 * `node_secret` در اولین استفاده تولید می‌شود؛ عوض کردنش همه‌ی نودها را قطع
 * می‌کند، پس در UI هشدار دارد.
 */
import { randomToken, sha256Hex } from '../lib/crypto';
import { setSettings, type Settings } from '../lib/settings';
import { nodeKey } from '../node/api';
import { HttpError } from './clients';
import { TLS_PORTS, type Env } from '../types';

export async function listNodes(env: Env): Promise<unknown[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT n.*,
            (SELECT COALESCE(SUM(u.up + u.down), 0) FROM client_usage_daily u WHERE u.node = n.name AND u.day = ?) AS today_bytes
       FROM nodes n ORDER BY n.weight DESC, n.id`,
  )
    .bind(new Date(now * 1000).toISOString().slice(0, 10))
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export interface NodeInput {
  id?: number;
  name?: string;
  host?: string;
  url?: string;
  enable?: boolean;
  ports?: number[] | string;
  proxyip?: string;
  region?: string;
  weight?: number;
}

/** `node_secret` را برمی‌گرداند و اگر نبود می‌سازد. */
async function ensureSecret(env: Env, s: Settings): Promise<string> {
  const cur = s.get('node_secret');
  if (cur) return cur;
  const secret = randomToken(32);
  await setSettings(env, { node_secret: secret });
  return secret;
}

export async function saveNode(
  env: Env,
  s: Settings,
  input: NodeInput,
): Promise<{ id: number; name: string; token?: string; panel_url?: string }> {
  const name = (input.name ?? '').trim();
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(name)) throw new HttpError(400, 'نام نود باید ۲ تا ۶۴ کاراکتر انگلیسی باشد');
  const host = (input.host ?? '').trim();
  if (!host) throw new HttpError(400, 'دامنه‌ی نود لازم است');

  const secret = await ensureSecret(env, s);
  const token = await nodeKey(secret, name);
  const ports = JSON.stringify(normalizePorts(input.ports));

  const args = [
    name,
    host,
    (input.url ?? '').trim(),
    await sha256Hex(token),
    input.enable === false ? 0 : 1,
    ports,
    input.proxyip ?? '',
    input.region ?? '',
    Math.max(1, Math.floor(input.weight ?? 100)),
  ];

  let id = input.id ?? 0;
  if (id > 0) {
    await env.DB.prepare(
      'UPDATE nodes SET name=?, host=?, url=?, token_hash=?, enable=?, ports=?, proxyip=?, region=?, weight=? WHERE id=?',
    )
      .bind(...args, id)
      .run();
  } else {
    const dup = await env.DB.prepare('SELECT id FROM nodes WHERE name = ?').bind(name).first<{ id: number }>();
    if (dup) throw new HttpError(409, `نودی با نام «${name}» وجود دارد`);
    const res = await env.DB.prepare(
      'INSERT INTO nodes (name, host, url, token_hash, enable, ports, proxyip, region, weight) VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind(...args)
      .run();
    id = Number(res.meta.last_row_id);
  }

  // توکن فقط همین‌جا برگردانده می‌شود تا در ویزارد کپی شود.
  return { id, name, token };
}

/** توکن یک نود موجود را دوباره نشان می‌دهد (قابل بازتولید است، پس امن است). */
export async function nodeToken(env: Env, s: Settings, name: string): Promise<{ name: string; token: string }> {
  const row = await env.DB.prepare('SELECT name FROM nodes WHERE name = ?').bind(name).first<{ name: string }>();
  if (!row) throw new HttpError(404, 'نود پیدا نشد');
  const secret = await ensureSecret(env, s);
  return { name, token: await nodeKey(secret, name) };
}

export async function deleteNode(env: Env, id: number): Promise<number> {
  const r = await env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(id).run();
  return r.meta.changes ?? 0;
}

function normalizePorts(raw: number[] | string | undefined): number[] {
  if (Array.isArray(raw)) {
    const out = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (out.length) return [...new Set(out)];
  }
  if (typeof raw === 'string' && raw.trim()) {
    const out = raw
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (out.length) return [...new Set(out)];
  }
  return [...TLS_PORTS];
}
