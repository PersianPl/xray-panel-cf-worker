/**
 * پروفایل‌های مسیریابی — قابلیتی که هیچ پنل Worker دیگری ندارد.
 *
 * ایده: قواعد سمت‌کلاینت (bypass/block/dns) به‌صورت «پروفایل» نام‌دار ذخیره
 * می‌شوند و هر کلاینت می‌تواند `routing_id` خودش را داشته باشد. هنگام ساخت ساب،
 * قواعد پروفایل روی تنظیمات عمومی «اورلی» می‌شوند — یعنی فقط فیلدهایی که پروفایل
 * واقعاً ست کرده جایگزین می‌شوند و بقیه از تنظیمات کلی می‌آیند.
 *
 * شکل JSON ذخیره‌شده (همه‌ی فیلدها اختیاری):
 *   { bypass_iran, bypass_lan, block_ads, block_porn, block_quic, ipv6, fakedns,
 *     dns_remote, dns_local, direct, block, proxy }
 * سه فیلد آخر چندخطیِ قواعد سفارشی‌اند: هر خط یک دامنه یا IP/CIDR؛ خطوطی که با
 * «ip:» شروع شوند IP حساب می‌شوند.
 */
import type { Env } from '../types';
import { invalidateClients } from '../proxy/store';
import { HttpError } from './clients';

export interface RoutingRules {
  bypass_iran?: boolean;
  bypass_lan?: boolean;
  block_ads?: boolean;
  block_porn?: boolean;
  block_quic?: boolean;
  ipv6?: boolean;
  fakedns?: boolean;
  dns_remote?: string;
  dns_local?: string;
  direct?: string;
  block?: string;
  proxy?: string;
}

export interface RoutingProfile {
  id: number;
  name: string;
  is_default: number;
  rules: RoutingRules;
  created_at: number;
  /** چند کلاینت از این پروفایل استفاده می‌کنند (پرشده در listProfiles). */
  clients?: number;
}

interface ProfileRow {
  id: number;
  name: string;
  is_default: number;
  rules: string;
  created_at: number;
  clients: number;
}

function parseRules(raw: string): RoutingRules {
  try {
    const j = JSON.parse(raw) as RoutingRules;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function cleanRules(input: RoutingRules): RoutingRules {
  const out: RoutingRules = {};
  for (const k of ['bypass_iran', 'bypass_lan', 'block_ads', 'block_porn', 'block_quic', 'ipv6', 'fakedns'] as const) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  for (const k of ['dns_remote', 'dns_local'] as const) {
    const v = typeof input[k] === 'string' ? (input[k] as string).trim() : '';
    // هر URL/آدرس می‌پذیریم ولی طول را می‌بندیم تا دیتابیس آشغال نشود.
    if (v && v.length <= 200) out[k] = v;
  }
  for (const k of ['direct', 'block', 'proxy'] as const) {
    const v = typeof input[k] === 'string' ? input[k] : '';
    const lines = v
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (lines.length) out[k] = lines.join('\n');
  }
  return out;
}

function toProfile(r: ProfileRow): RoutingProfile {
  return {
    id: r.id,
    name: r.name,
    is_default: r.is_default,
    rules: parseRules(r.rules),
    created_at: r.created_at,
    ...(r.clients !== undefined ? { clients: r.clients } : {}),
  };
}

export async function listProfiles(env: Env): Promise<RoutingProfile[]> {
  const rs = await env.DB.prepare(
    `SELECT p.id, p.name, p.is_default, p.rules, p.created_at,
            (SELECT COUNT(*) FROM clients c WHERE c.routing_id = p.id) AS clients
       FROM routing_profiles p ORDER BY p.is_default DESC, p.id ASC`,
  ).all<ProfileRow>();
  return (rs.results ?? []).map(toProfile);
}

export async function createProfile(env: Env, name: string, rules: RoutingRules): Promise<RoutingProfile> {
  const clean = name.trim().slice(0, 64);
  if (!clean) throw new HttpError(400, 'نام پروفایل الزامی است');
  const parsed = cleanRules(rules);
  const res = await env.DB.prepare('INSERT INTO routing_profiles (name, rules) VALUES (?, ?)')
    .bind(clean, JSON.stringify(parsed))
    .run();
  return {
    id: Number(res.meta.last_row_id),
    name: clean,
    is_default: 0,
    rules: parsed,
    created_at: Math.floor(Date.now() / 1000),
    clients: 0,
  };
}

export async function updateProfile(env: Env, id: number, patch: { name?: string; rules?: RoutingRules }): Promise<void> {
  const cur = await env.DB.prepare('SELECT id FROM routing_profiles WHERE id = ?')
    .bind(id)
    .first<{ id: number }>();
  if (!cur) throw new HttpError(404, 'پروفایل پیدا نشد');
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.name === 'string' && patch.name.trim()) {
    sets.push('name = ?');
    args.push(patch.name.trim().slice(0, 64));
  }
  if (patch.rules && typeof patch.rules === 'object') {
    sets.push('rules = ?');
    args.push(JSON.stringify(cleanRules(patch.rules)));
  }
  if (!sets.length) return;
  args.push(id);
  await env.DB.prepare(`UPDATE routing_profiles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args)
    .run();
}

/** پیش‌فرض کردن: پروفایلِ بدون تخصیصِ صریحِ کلاینت‌ها این را می‌گیرند (در ساب‌ساز). */
export async function setDefaultProfile(env: Env, id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE routing_profiles SET is_default = 0 WHERE is_default = 1'),
    env.DB.prepare('UPDATE routing_profiles SET is_default = 1 WHERE id = ?').bind(id),
  ]);
}

export async function deleteProfile(env: Env, id: number): Promise<void> {
  // اول مرجع کلاینت‌ها آزاد می‌شود تا FK یتیم نماند.
  await env.DB.batch([
    env.DB.prepare('UPDATE clients SET routing_id = NULL WHERE routing_id = ?').bind(id),
    env.DB.prepare('DELETE FROM routing_profiles WHERE id = ?').bind(id),
  ]);
  invalidateClients();
}

/** قواعد پروفایل (یا پیش‌فرض) برای یک کلاینت — در ساب‌ساز روی flags اورلی می‌شود. */
export async function resolveProfileRules(env: Env, routingId: number | null): Promise<RoutingRules | null> {
  if (routingId) {
    const r = await env.DB.prepare('SELECT rules FROM routing_profiles WHERE id = ?')
      .bind(routingId)
      .first<{ rules: string }>();
    if (r) return parseRules(r.rules);
  }
  // پروفایل پیش‌فرض هم فقط وقتی کلاینت تخصیص صریح ندارد اعمال نمی‌شود؛
  // پیش‌فرض یعنی «کاندید جدید»، نه اجبار روی همه — پس اینجا همان null.
  return null;
}
