/**
 * بکاپ/ریستور کامل — یک فایل JSON شامل همه‌ی جدول‌های معنادار.
 *
 * محدودیت‌های D1 که طرح را تعیین می‌کنند:
 *   • حداکثر ۵۰ عبارت در هر invocation و ۱۰۰ پارامتر در هر عبارت
 *   • هر `DB.batch` یک تراکنش اتمیک است
 * پس درج‌ها با VALUES چندردیفی (تا ۹۰ پارامتر در هر عبارت) بسته می‌شوند؛
 * اگر کل عبارت‌ها ≤ ۴۵ شد، همه‌چیز در **یک** دسته‌ی اتمیک می‌رود؛ وگرنه
 * به‌ترتیب وابستگی FK در چند دسته (هر دسته اتمیک، کل عملیات نه — فقط برای
 * پنل‌های خیلی بزرگ پیش می‌آید).
 *
 * عمداً بازگردانی نمی‌شوند (و حذف هم نمی‌شوند):
 *   • `client_usage_daily` و `client_ips` — تاریخچه‌ی چارت و IPها؛ چون
 *     شناسه‌ی کاربران حفظ می‌شود، این ردیف‌ها بعد از ریستور همچنان معتبرند
 *   • `sessions` و `audit_log` — نشست فعلی شما نمی‌پرد
 * جمع مصرف (up/down) خودِ ردیف کلاینت است و با ریستور برمی‌گردد.
 */
import type { Env } from '../types';

const VERSION = 1;
export const APP_NAME = 'PersianPl-Panel';

type Row = Record<string, unknown>;

export interface BackupData {
  version: number;
  app: string;
  at: number;
  settings: Record<string, string>;
  inbounds: Row[];
  clients: Row[];
  nodes: Row[];
  routing_profiles: Row[];
  api_keys: Row[];
}

/** ستون‌های هر جدول — ترتیب SELECT و INSERT یکی است. */
const COLS = {
  inbounds: {
    cols: 'id,tag,remark,enable,protocol,transport,path,host,sni,ports,max_early_data,ss_method,vmess_security,total_gb,traffic_reset,last_reset_at,expiry_at,up,down,extra,created_at',
    perRow: 21,
  },
  clients: {
    cols: 'id,inbound_id,name,comment,auth,enable,total_gb,up,down,expiry_at,delayed_days,renew_days,reset_count,limit_ip,sub_token,tg_chat_id,pref_node,proxyip,nat64_prefix,routing_id,gen_opts,last_online,first_seen,created_at',
    perRow: 24,
  },
  nodes: {
    cols: 'id,name,host,url,token_hash,enable,ports,proxyip,region,weight,last_seen,req_today,health,created_at',
    perRow: 15,
  },
  routing_profiles: { cols: 'id,name,is_default,rules,created_at', perRow: 5 },
  api_keys: { cols: 'id,name,key_hash,scope,last_used,created_at', perRow: 6 },
  settings: { cols: 'k,v', perRow: 3 },
} satisfies Record<string, { cols: string; perRow: number }>;

export async function exportBackup(env: Env): Promise<BackupData> {
  const [settings, inbounds, clients, nodes, routing, keys] = await Promise.all([
    env.DB.prepare('SELECT k, v FROM settings ORDER BY k').all<{ k: string; v: string }>(),
    env.DB.prepare(`SELECT ${COLS.inbounds.cols} FROM inbounds ORDER BY id`).all<Row>(),
    env.DB.prepare(`SELECT ${COLS.clients.cols} FROM clients ORDER BY id`).all<Row>(),
    env.DB.prepare(`SELECT ${COLS.nodes.cols} FROM nodes ORDER BY id`).all<Row>(),
    env.DB.prepare(`SELECT ${COLS.routing_profiles.cols} FROM routing_profiles ORDER BY id`).all<Row>(),
    env.DB.prepare(`SELECT ${COLS.api_keys.cols} FROM api_keys ORDER BY id`).all<Row>(),
  ]);
  return {
    version: VERSION,
    app: APP_NAME,
    at: Math.floor(Date.now() / 1000),
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.k, r.v])),
    inbounds: inbounds.results ?? [],
    clients: clients.results ?? [],
    nodes: nodes.results ?? [],
    routing_profiles: routing.results ?? [],
    api_keys: keys.results ?? [],
  };
}

/**
 * بازگردانی. داده‌ی ورودی همان خروجی `exportBackup` است (با همان IDها، پس
 * ارجاع‌ها و تاریخچه‌ی مصرف سالم می‌مانند).
 */
export async function restoreBackup(
  env: Env,
  raw: unknown,
): Promise<{ ok: true; restored: Record<string, number> } | { ok: false; error: string }> {
  const check = validate(raw);
  if (!check.ok) return { ok: false, error: check.error };
  const data = check.data;

  // درج چندردیفی: عبارت‌ها را کم می‌کند تا زیر سقف ۵۰ عبارت بمانیم.
  const ins = (table: keyof typeof COLS, rows: Row[]): D1PreparedStatement[] => {
    const { cols, perRow } = COLS[table];
    const names = cols.split(',');
    const perStmt = Math.max(1, Math.floor(90 / perRow));
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += perStmt) {
      const chunk = rows.slice(i, i + perStmt);
      const values = chunk.map(() => `(${names.map(() => '?').join(',')})`).join(',');
      const args = chunk.flatMap((r) => names.map((c) => (r[c] === undefined ? null : r[c])));
      out.push(env.DB.prepare(`INSERT INTO ${table} (${cols}) VALUES ${values}`).bind(...args));
    }
    return out;
  };

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM clients'),
    env.DB.prepare('DELETE FROM inbounds'),
    env.DB.prepare('DELETE FROM nodes'),
    env.DB.prepare('DELETE FROM routing_profiles'),
    env.DB.prepare('DELETE FROM api_keys'),
    ...ins('inbounds', data.inbounds),
    ...ins('clients', data.clients),
    ...ins('nodes', data.nodes),
    ...ins('routing_profiles', data.routing_profiles),
    ...ins('api_keys', data.api_keys),
    env.DB.prepare('DELETE FROM settings'),
    ...ins('settings', Object.entries(data.settings).map(([k, v]) => ({ k, v }))),
  ];

  if (stmts.length <= 45) {
    await env.DB.batch(stmts); // اتمیک کامل
  } else {
    for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  }

  return {
    ok: true,
    restored: {
      settings: Object.keys(data.settings).length,
      inbounds: data.inbounds.length,
      clients: data.clients.length,
      nodes: data.nodes.length,
      routing_profiles: data.routing_profiles.length,
      api_keys: data.api_keys.length,
    },
  };
}

/** اعتبارسنجی ساختار پشتیبان — پیش از هر نوشتنی. */
function validate(raw: unknown): { ok: true; data: BackupData } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'بدنه‌ی JSON نامعتبر است' };
  const d = raw as Partial<BackupData>;
  if (d.version !== VERSION || d.app !== APP_NAME) return { ok: false, error: 'این فایل پشتیبانِ این پنل نیست' };
  if (typeof d.settings !== 'object' || d.settings === null) return { ok: false, error: 'فایل پشتیبان ناقص است' };

  const need: Record<string, string[]> = {
    inbounds: ['id', 'protocol'],
    clients: ['id', 'inbound_id', 'name', 'auth'],
    nodes: ['id', 'name', 'token_hash'],
    routing_profiles: ['id', 'name'],
    api_keys: ['id', 'key_hash'],
  };
  for (const [table, fields] of Object.entries(need)) {
    const rows = (d[table as keyof BackupData] as Row[] | undefined) ?? [];
    if (!Array.isArray(rows)) return { ok: false, error: `فایل پشتیبان ناقص است (${table})` };
    for (const r of rows) {
      for (const f of fields) {
        if (r[f] === undefined) return { ok: false, error: `فایل پشتیبان ناقص است (${table}.${f})` };
      }
    }
  }

  // یکپارچگی FK: کلاینت‌ها باید به inboundهای همین فایل اشاره کنند.
  const ibIds = new Set((d.inbounds ?? []).map((r) => Number(r.id)));
  for (const c of d.clients ?? []) {
    if (!ibIds.has(Number(c.inbound_id))) {
      return { ok: false, error: `کاربر «${String(c.name)}» به inbound ناموجود در فایل اشاره می‌کند` };
    }
  }

  return {
    ok: true,
    data: {
      version: VERSION,
      app: APP_NAME,
      at: Number(d.at) || Math.floor(Date.now() / 1000),
      settings: d.settings as Record<string, string>,
      inbounds: d.inbounds ?? [],
      clients: d.clients ?? [],
      nodes: d.nodes ?? [],
      routing_profiles: d.routing_profiles ?? [],
      api_keys: d.api_keys ?? [],
    },
  };
}