/**
 * آمار داشبورد — یک بار خواندن، چند عدد.
 *
 * همه‌ی شمارش‌ها در **یک** کوئری تجمعی می‌آیند نه چند SELECT جدا: سقف ۵۰
 * کوئری در هر invocation و تأخیر D1 (هر رفت‌وبرگشت چند میلی‌ثانیه) باعث
 * می‌شود جمع‌کردن شرط‌ها در `SUM(CASE WHEN …)` هم سریع‌تر باشد هم ارزان‌تر.
 */
import type { Settings } from '../lib/settings';
import type { Env } from '../types';

const GB = 1024 * 1024 * 1024;
/** کاربری که در این بازه دیده شده «آنلاین» است. */
const ONLINE_SEC = 300;

export interface DashboardStats {
  clients: { total: number; active: number; disabled: number; expired: number; depleted: number; online: number };
  traffic: { up: number; down: number; total: number };
  inbounds: Array<{ id: number; tag: string; protocol: string; up: number; down: number; clients: number }>;
  nodes: Array<{ name: string; region: string; health: string; last_seen: number; req_today: number }>;
  /** ۳۰ روز اخیر برای نمودار. */
  daily: Array<{ day: string; up: number; down: number }>;
  /** کاربران پرمصرف امروز. */
  top: Array<{ id: number; name: string; up: number; down: number }>;
  /** انقضاهای نزدیک (۷ روز آینده). */
  expiring: Array<{ id: number; name: string; expiry_at: number }>;
  /** سهمیه‌ی امروزِ CF اگر توکن API ست شده باشد. */
  cf: { requests: number | null; limit: number } | null;
}

export async function dashboardStats(env: Env, s: Settings): Promise<DashboardStats> {
  const now = Math.floor(Date.now() / 1000);
  const from = new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10);
  const today = new Date(now * 1000).toISOString().slice(0, 10);

  const [summary, inbounds, nodes, daily, top, expiring] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enable = 1 AND (expiry_at = 0 OR expiry_at > ?) THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN enable = 0 THEN 1 ELSE 0 END) AS disabled,
              SUM(CASE WHEN expiry_at > 0 AND expiry_at <= ? THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN total_gb > 0 AND (up + down) >= total_gb * ? THEN 1 ELSE 0 END) AS depleted,
              SUM(CASE WHEN last_online > ? THEN 1 ELSE 0 END) AS online,
              COALESCE(SUM(up), 0) AS up, COALESCE(SUM(down), 0) AS down
         FROM clients`,
    )
      .bind(now, now, GB, now - ONLINE_SEC)
      .first<Record<string, number>>(),

    env.DB.prepare(
      `SELECT i.id, i.tag, i.protocol, i.up, i.down,
              (SELECT COUNT(*) FROM clients c WHERE c.inbound_id = i.id) AS clients
         FROM inbounds i ORDER BY i.id`,
    ).all<{ id: number; tag: string; protocol: string; up: number; down: number; clients: number }>(),

    env.DB.prepare('SELECT name, region, health, last_seen, req_today FROM nodes ORDER BY weight DESC').all<{
      name: string;
      region: string;
      health: string;
      last_seen: number;
      req_today: number;
    }>(),

    env.DB.prepare(
      'SELECT day, SUM(up) AS up, SUM(down) AS down FROM client_usage_daily WHERE day >= ? GROUP BY day ORDER BY day',
    )
      .bind(from)
      .all<{ day: string; up: number; down: number }>(),

    env.DB.prepare(
      `SELECT c.id, c.name, SUM(u.up) AS up, SUM(u.down) AS down
         FROM client_usage_daily u JOIN clients c ON c.id = u.client_id
        WHERE u.day = ? GROUP BY c.id ORDER BY (SUM(u.up) + SUM(u.down)) DESC LIMIT 10`,
    )
      .bind(today)
      .all<{ id: number; name: string; up: number; down: number }>(),

    env.DB.prepare(
      'SELECT id, name, expiry_at FROM clients WHERE expiry_at > ? AND expiry_at <= ? ORDER BY expiry_at LIMIT 20',
    )
      .bind(now, now + 7 * 86400)
      .all<{ id: number; name: string; expiry_at: number }>(),
  ]);

  const up = summary?.up ?? 0;
  const down = summary?.down ?? 0;

  return {
    clients: {
      total: summary?.total ?? 0,
      active: summary?.active ?? 0,
      disabled: summary?.disabled ?? 0,
      expired: summary?.expired ?? 0,
      depleted: summary?.depleted ?? 0,
      online: summary?.online ?? 0,
    },
    traffic: { up, down, total: up + down },
    inbounds: inbounds.results ?? [],
    nodes: nodes.results ?? [],
    daily: daily.results ?? [],
    top: top.results ?? [],
    expiring: expiring.results ?? [],
    cf: await cfQuota(env, s),
  };
}

/**
 * مصرف ریکوئست امروز از GraphQL خود کلادفلر.
 *
 * فقط وقتی صدا زده می‌شود که توکن ست شده باشد. خطا برنمی‌گرداند چون داشبورد
 * نباید به‌خاطر یک سرویس جانبی خالی بماند — `requests: null` یعنی «نمی‌دانیم».
 */
async function cfQuota(env: Env, s: Settings): Promise<DashboardStats['cf']> {
  const token = s.get('cf_api_token');
  const account = s.get('cf_account_id');
  if (!token || !account) return null;

  const day = new Date().toISOString().slice(0, 10);
  const query = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{date:$d}){sum{requests}}}}}`;

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { a: account, d: day } }),
    });
    if (!res.ok) return { requests: null, limit: 100_000 };
    const data = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } };
    };
    const rows = data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    let total = 0;
    for (const r of rows) total += r.sum?.requests ?? 0;
    return { requests: total, limit: 100_000 };
  } catch {
    return { requests: null, limit: 100_000 };
  }
}
