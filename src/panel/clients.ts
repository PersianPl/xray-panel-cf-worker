/**
 * CRUD کلاینت‌ها — قلب پنل. همه‌ی فیلدهای ۳.۳ پلن اینجا پشتیبانی می‌شوند.
 *
 * تصمیم‌های طراحی:
 *   • `auth` بر اساس پروتکل inbound تولید می‌شود: UUID برای vless/vmess، رمز
 *     تصادفی برای trojan/ss. یکتایی با ایندکس یکتای D1 تضمین می‌شود، نه با
 *     چک قبلی (که مسابقه‌ای است).
 *   • «شروع تعویقی» با `delayed_days > 0` و `first_seen = 0` نشان داده می‌شود؛
 *     تاریخ انقضا در اولین اتصال محاسبه می‌شود (در `lib/usage.ts`).
 *   • ساخت گروهی پنج الگوی نام‌گذاری دارد و در یک `batch` می‌نشیند.
 */
import { randomId, randomToken, uuidv4 } from '../lib/crypto';
import { invalidateClients } from '../proxy/store';
import type { Env } from '../types';

const GB = 1024 * 1024 * 1024;
/** سقف ساخت گروهی در یک درخواست. */
const MAX_BULK = 100;

export interface ClientInput {
  inbound_id: number;
  name: string;
  comment?: string;
  auth?: string;
  enable?: boolean;
  total_gb?: number;
  expiry_at?: number;
  /** روزهای اعتبار از «الان» — جایگزین راحت‌تر `expiry_at`. */
  expiry_days?: number;
  delayed_days?: number;
  renew_days?: number;
  limit_ip?: number;
  tg_chat_id?: string;
  pref_node?: string;
  proxyip?: string;
  nat64_prefix?: string;
  routing_id?: number | null;
  gen_opts?: unknown;
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  inboundId?: number;
  /** فقط فعال / فقط غیرفعال / همه. */
  status?: 'all' | 'active' | 'disabled' | 'expired' | 'depleted' | 'online';
  sort?: string;
  dir?: 'asc' | 'desc';
}

/** ستون‌های مجاز برای مرتب‌سازی — جلوگیری از تزریق در ORDER BY. */
const SORTABLE = new Set([
  'id',
  'name',
  'up',
  'down',
  'total',
  'total_gb',
  'expiry_at',
  'last_online',
  'created_at',
  'limit_ip',
]);

export async function listClients(env: Env, q: ListQuery): Promise<{ rows: unknown[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(5, Math.floor(q.pageSize ?? 25)));
  const now = Math.floor(Date.now() / 1000);

  const where: string[] = [];
  const args: unknown[] = [];

  if (q.inboundId) {
    where.push('c.inbound_id = ?');
    args.push(q.inboundId);
  }
  if (q.search) {
    where.push('(c.name LIKE ? OR c.comment LIKE ? OR c.auth LIKE ? OR c.sub_token = ?)');
    const like = `%${q.search}%`;
    args.push(like, like, like, q.search);
  }
  switch (q.status) {
    case 'active':
      where.push('c.enable = 1 AND (c.expiry_at = 0 OR c.expiry_at > ?)');
      args.push(now);
      break;
    case 'disabled':
      where.push('c.enable = 0');
      break;
    case 'expired':
      where.push('c.expiry_at > 0 AND c.expiry_at <= ?');
      args.push(now);
      break;
    case 'depleted':
      where.push('c.total_gb > 0 AND (c.up + c.down) >= c.total_gb * ?');
      args.push(GB);
      break;
    case 'online':
      where.push('c.last_online > ?');
      args.push(now - 300);
      break;
    default:
      break;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = SORTABLE.has(q.sort ?? '') ? q.sort! : 'id';
  const orderExpr = sortCol === 'total' ? '(c.up + c.down)' : `c.${sortCol}`;
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';

  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT c.*, i.tag AS inbound_tag, i.protocol, i.transport,
              (c.up + c.down) AS used,
              (SELECT COUNT(*) FROM client_ips p WHERE p.client_id = c.id AND p.last_seen > ${now - 300}) AS online_ips
         FROM clients c JOIN inbounds i ON i.id = c.inbound_id
         ${clause}
        ORDER BY ${orderExpr} ${dir}
        LIMIT ? OFFSET ?`,
    )
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM clients c ${clause}`)
      .bind(...args)
      .first<{ n: number }>(),
  ]);

  return { rows: rows.results ?? [], total: count?.n ?? 0, page, pageSize };
}

/** رمز/شناسه‌ی احراز مناسب پروتکل. */
export function makeAuth(protocol: string): string {
  return protocol === 'vless' || protocol === 'vmess' ? uuidv4() : randomToken(16);
}

/** تاریخ انقضا از ورودی: `expiry_days` بر `expiry_at` مقدم است. */
function resolveExpiry(input: { expiry_days?: number; expiry_at?: number }): number {
  if (typeof input.expiry_days === 'number' && input.expiry_days > 0) {
    return Math.floor(Date.now() / 1000) + Math.floor(input.expiry_days) * 86400;
  }
  return Math.max(0, Math.floor(input.expiry_at ?? 0));
}

export async function createClient(env: Env, input: ClientInput): Promise<{ id: number; auth: string; sub_token: string }> {
  const ib = await env.DB.prepare('SELECT protocol FROM inbounds WHERE id = ?')
    .bind(input.inbound_id)
    .first<{ protocol: string }>();
  if (!ib) throw new HttpError(400, 'inbound پیدا نشد');

  const name = (input.name || '').trim();
  if (!name) throw new HttpError(400, 'نام کاربر لازم است');

  const auth = (input.auth || '').trim() || makeAuth(ib.protocol);
  const subToken = randomId(16);

  const res = await env.DB.prepare(
    `INSERT INTO clients
       (inbound_id, name, comment, auth, enable, total_gb, expiry_at, delayed_days, renew_days,
        limit_ip, sub_token, tg_chat_id, pref_node, proxyip, nat64_prefix, routing_id, gen_opts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.inbound_id,
      name,
      input.comment ?? '',
      auth,
      input.enable === false ? 0 : 1,
      Math.max(0, input.total_gb ?? 0),
      resolveExpiry(input),
      Math.max(0, Math.floor(input.delayed_days ?? 0)),
      Math.max(0, Math.floor(input.renew_days ?? 0)),
      Math.max(0, Math.floor(input.limit_ip ?? 0)),
      subToken,
      input.tg_chat_id ?? '',
      input.pref_node ?? '',
      input.proxyip ?? '',
      input.nat64_prefix ?? '',
      input.routing_id ?? null,
      JSON.stringify(input.gen_opts ?? {}),
    )
    .run();

  invalidateClients();
  return { id: Number(res.meta.last_row_id), auth, sub_token: subToken };
}

/** خطای HTTPدار تا لایه‌ی روتر بتواند کد درست بدهد. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** ستون‌هایی که ویرایششان مجاز است، با نوعشان. */
const EDITABLE: Record<string, 'text' | 'int' | 'real' | 'bool' | 'json' | 'nullable-int'> = {
  name: 'text',
  comment: 'text',
  auth: 'text',
  enable: 'bool',
  total_gb: 'real',
  expiry_at: 'int',
  delayed_days: 'int',
  renew_days: 'int',
  limit_ip: 'int',
  tg_chat_id: 'text',
  pref_node: 'text',
  proxyip: 'text',
  nat64_prefix: 'text',
  routing_id: 'nullable-int',
  gen_opts: 'json',
  inbound_id: 'int',
};

export async function updateClient(env: Env, id: number, patch: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];

  // `expiry_days` قند نحوی است و به `expiry_at` تبدیل می‌شود.
  if (typeof patch.expiry_days === 'number' && patch.expiry_days > 0) {
    sets.push('expiry_at = ?');
    args.push(Math.floor(Date.now() / 1000) + Math.floor(patch.expiry_days) * 86400);
  }

  for (const [k, kind] of Object.entries(EDITABLE)) {
    if (!(k in patch)) continue;
    const v = patch[k];
    sets.push(`${k} = ?`);
    switch (kind) {
      case 'bool':
        args.push(v ? 1 : 0);
        break;
      case 'int':
        args.push(Math.max(0, Math.floor(Number(v) || 0)));
        break;
      case 'real':
        args.push(Math.max(0, Number(v) || 0));
        break;
      case 'nullable-int':
        args.push(v === null || v === '' ? null : Math.floor(Number(v) || 0));
        break;
      case 'json':
        args.push(typeof v === 'string' ? v : JSON.stringify(v ?? {}));
        break;
      default:
        args.push(String(v ?? ''));
    }
  }

  if (!sets.length) return;
  await env.DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args, id)
    .run();
  invalidateClients();
}

export async function deleteClients(env: Env, ids: number[]): Promise<number> {
  const clean = ids.map((x) => Math.floor(Number(x))).filter((x) => Number.isInteger(x) && x > 0);
  if (!clean.length) return 0;
  // ON DELETE CASCADE بقیه‌ی جدول‌ها را پاک می‌کند.
  const marks = clean.map(() => '?').join(',');
  const r = await env.DB.prepare(`DELETE FROM clients WHERE id IN (${marks})`)
    .bind(...clean)
    .run();
  invalidateClients();
  return r.meta.changes ?? 0;
}

/** ریست مصرف: شمارنده صفر و `reset_count` یکی جلو. */
export async function resetUsageOf(env: Env, ids: number[]): Promise<number> {
  const clean = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!clean.length) return 0;
  const marks = clean.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `UPDATE clients SET up = 0, down = 0, reset_count = reset_count + 1 WHERE id IN (${marks})`,
  )
    .bind(...clean)
    .run();
  invalidateClients();
  return r.meta.changes ?? 0;
}

/** تمدید دستی: N روز به انقضا اضافه می‌کند (از «الان» اگر منقضی شده). */
export async function renewClients(env: Env, ids: number[], days: number, alsoReset: boolean): Promise<number> {
  const clean = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!clean.length || days <= 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const add = Math.floor(days) * 86400;
  const marks = clean.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `UPDATE clients
        SET expiry_at = CASE WHEN expiry_at > ? THEN expiry_at + ? ELSE ? + ? END,
            enable = 1
            ${alsoReset ? ', up = 0, down = 0, reset_count = reset_count + 1' : ''}
      WHERE id IN (${marks})`,
  )
    .bind(now, add, now, add, ...clean)
    .run();
  invalidateClients();
  return r.meta.changes ?? 0;
}

/** توکن ساب را عوض می‌کند (وقتی لینک لو رفته). */
export async function rotateSubToken(env: Env, id: number): Promise<string> {
  const token = randomId(16);
  await env.DB.prepare('UPDATE clients SET sub_token = ? WHERE id = ?').bind(token, id).run();
  invalidateClients();
  return token;
}

/** شناسه‌ی احراز را دوباره تولید می‌کند (کاربر باید ساب را به‌روز کند). */
export async function rotateAuth(env: Env, id: number): Promise<string> {
  const row = await env.DB.prepare('SELECT i.protocol FROM clients c JOIN inbounds i ON i.id = c.inbound_id WHERE c.id = ?')
    .bind(id)
    .first<{ protocol: string }>();
  if (!row) throw new HttpError(404, 'کاربر پیدا نشد');
  const auth = makeAuth(row.protocol);
  await env.DB.prepare('UPDATE clients SET auth = ? WHERE id = ?').bind(auth, id).run();
  invalidateClients();
  return auth;
}

export async function clearIps(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM client_ips WHERE client_id = ?').bind(id).run();
  invalidateClients();
}

export type BulkNaming = 'random' | 'prefix' | 'number' | 'postfix' | 'prefix-number';

export interface BulkInput extends Omit<ClientInput, 'name'> {
  count: number;
  naming: BulkNaming;
  /** پیشوند/پسوند بر اساس `naming`. */
  base?: string;
  /** شماره‌ی شروع برای حالت‌های شماره‌دار. */
  start?: number;
}

/**
 * ساخت گروهی. پنج الگو:
 *   • `random`        → `k7m2p9qr`
 *   • `prefix`        → `base-k7m2p9`
 *   • `number`        → `1`, `2`, …
 *   • `postfix`       → `k7m2p9-base`
 *   • `prefix-number` → `base-1`, `base-2`, …
 */
export async function bulkCreate(env: Env, input: BulkInput): Promise<{ created: number; names: string[] }> {
  const count = Math.min(MAX_BULK, Math.max(1, Math.floor(input.count)));
  const ib = await env.DB.prepare('SELECT protocol FROM inbounds WHERE id = ?')
    .bind(input.inbound_id)
    .first<{ protocol: string }>();
  if (!ib) throw new HttpError(400, 'inbound پیدا نشد');

  const base = (input.base ?? '').trim();
  const start = Math.max(0, Math.floor(input.start ?? 1));
  const expiry = resolveExpiry(input);
  const names: string[] = [];
  const stmts: D1PreparedStatement[] = [];

  for (let i = 0; i < count; i++) {
    const n = start + i;
    const rnd = randomId(8);
    const name =
      input.naming === 'prefix'
        ? `${base}-${rnd}`
        : input.naming === 'postfix'
          ? `${rnd}-${base}`
          : input.naming === 'number'
            ? String(n)
            : input.naming === 'prefix-number'
              ? `${base}-${n}`
              : rnd;
    names.push(name);

    stmts.push(
      env.DB.prepare(
        `INSERT INTO clients
           (inbound_id, name, comment, auth, enable, total_gb, expiry_at, delayed_days, renew_days,
            limit_ip, sub_token, tg_chat_id, pref_node, proxyip, nat64_prefix, routing_id, gen_opts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        input.inbound_id,
        name,
        input.comment ?? '',
        makeAuth(ib.protocol),
        input.enable === false ? 0 : 1,
        Math.max(0, input.total_gb ?? 0),
        expiry,
        Math.max(0, Math.floor(input.delayed_days ?? 0)),
        Math.max(0, Math.floor(input.renew_days ?? 0)),
        Math.max(0, Math.floor(input.limit_ip ?? 0)),
        randomId(16),
        '',
        input.pref_node ?? '',
        input.proxyip ?? '',
        input.nat64_prefix ?? '',
        input.routing_id ?? null,
        JSON.stringify(input.gen_opts ?? {}),
      ),
    );
  }

  // ۱۰۰ عبارت در چند دسته، با فاصله از سقف ۵۰ کوئریِ D1.
  let created = 0;
  for (let i = 0; i < stmts.length; i += 40) {
    const out = await env.DB.batch(stmts.slice(i, i + 40));
    created += out.length;
  }
  invalidateClients();
  return { created, names };
}

/** یک کاربر با همه‌ی جزئیات + IPهای فعالش. */
export async function getClient(env: Env, id: number): Promise<unknown> {
  const now = Math.floor(Date.now() / 1000);
  const [row, ips, daily] = await Promise.all([
    env.DB.prepare(
      `SELECT c.*, i.tag AS inbound_tag, i.protocol, i.transport, i.path
         FROM clients c JOIN inbounds i ON i.id = c.inbound_id WHERE c.id = ?`,
    )
      .bind(id)
      .first<Record<string, unknown>>(),
    env.DB.prepare('SELECT ip, colo, last_seen FROM client_ips WHERE client_id = ? ORDER BY last_seen DESC LIMIT 50')
      .bind(id)
      .all<Record<string, unknown>>(),
    env.DB.prepare('SELECT day, node, up, down FROM client_usage_daily WHERE client_id = ? AND day >= ? ORDER BY day')
      .bind(id, new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10))
      .all<Record<string, unknown>>(),
  ]);
  if (!row) throw new HttpError(404, 'کاربر پیدا نشد');
  return { ...row, ips: ips.results ?? [], daily: daily.results ?? [] };
}

