/**
 * API پنل: همه‌ی مسیرهای زیر `/<panel_path>/api/…`.
 *
 * قرارداد پاسخ‌ها یکنواخت است: `{ok:true, …}` یا `{ok:false, error}` با کد
 * HTTP مناسب. UI فقط با همین قرارداد کار می‌کند تا لایه‌ی نمایش از منطق جدا
 * بماند.
 *
 * محافظت‌ها:
 *   • هر مسیر جز `login` نشست معتبر می‌خواهد
 *   • نوشتن‌ها (`POST`/`PUT`/`DELETE`) هدر `x-requested-with` می‌خواهند تا
 *     CSRF از طریق فرم ساده‌ی سایت دیگر ممکن نباشد (کوکی `SameSite=Strict` هم
 *     هست، این لایه‌ی دوم است)
 */
import { changePassword, currentSession, isSecureRequest, login, logout } from './auth';
import {
  HttpError,
  bulkCreate,
  clearIps,
  createClient,
  deleteClients,
  getClient,
  listClients,
  renewClients,
  resetUsageOf,
  rotateAuth,
  rotateSubToken,
  updateClient,
} from './clients';
import { listInbounds, saveInbound, deleteInbound } from './inbounds';
import { dashboardStats } from './stats';
import { listNodes, saveNode, deleteNode, nodeToken } from './nodes';
import { listKeys, createKey, deleteKey, type KeyScope } from './keys';
import { handleTgWebhook, setWebhook, deleteWebhook, botInfo } from '../tg/bot';
import { setSettings, type Settings } from '../lib/settings';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { exportBackup, restoreBackup } from './backup';
import { listProfiles, createProfile, updateProfile, deleteProfile, setDefaultProfile } from './routing';
import { importXui } from './importx';
import { registerWarp, wireguardConf, parseIdentity } from '../lib/warp';
import { byClientId, clientIndex, invalidateClients } from '../proxy/store';
import { buildFor } from '../sub/router';
import { qrSvg } from '../lib/qr';
import { runCron } from '../lib/cron';
import { page } from './ui';
import type { Env } from '../types';

export async function handlePanel(req: Request, env: Env, s: Settings, seg: string[]): Promise<Response> {
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const isApi = seg[0] === 'api';

  // ── ورود و خروج (بدون نشست)
  if (isApi && seg[1] === 'login' && req.method === 'POST') {
    const body = await readJson<{ user?: string; pass?: string; code?: string }>(req);
    const out = await login(env, s, body.user ?? '', body.pass ?? '', body.code ?? '', {
      ip,
      ua: req.headers.get('user-agent') ?? '',
      secure: isSecureRequest(req),
    });
    if (!out.ok) return json({ ok: false, error: out.reason }, 401);
    return json({ ok: true }, 200, { 'set-cookie': out.cookie });
  }

  const session = await currentSession(env, req);

  if (!session) {
    // صفحه‌ی ورود برای مرورگر، ۴۰۱ برای API.
    if (isApi) return json({ ok: false, error: 'وارد نشده‌اید' }, 401);
    return html(page({ view: 'login', s }));
  }

  if (isApi && seg[1] === 'logout') {
    const cookie = await logout(env, req, s);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  // ── وب‌هوک تلگرام: بدون نشست پنلی؛ احرازش با secret در مسیر + هدر است
  //    (تلگرام کوکی و هدر CSRF ما را نمی‌فرستد، پس باید پیش از بررسی نشست بیاید)
  if (isApi && seg[1] === 'telegram' && seg[2] === 'webhook') {
    return handleTgWebhook(req, env, s, seg[3] ?? '');
  }

  if (!isApi) return html(page({ view: 'app', s }));

  // ── از اینجا به بعد: API با نشست معتبر
  if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'PersianPl') {
    return json({ ok: false, error: 'درخواست نامعتبر' }, 403);
  }

  try {
    return await api(req, env, s, seg.slice(1), ip);
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
    // پیام خام خطای D1 می‌تواند ساختار جدول را لو بدهد.
    console.error('panel api', e instanceof Error ? e.stack : String(e));
    return json({ ok: false, error: 'خطای داخلی' }, 500);
  }
}

/** مسیریابی API. `seg[0]` منبع است و `seg[1]` معمولاً شناسه یا اکشن. */
async function api(req: Request, env: Env, s: Settings, seg: string[], ip: string): Promise<Response> {
  const [resource, a, b] = seg;
  const url = new URL(req.url);

  switch (resource) {
    // ── داشبورد
    case 'stats':
      return json({ ok: true, ...(await dashboardStats(env, s)) });

    // ── کلاینت‌ها
    case 'clients': {
      if (req.method === 'GET' && !a) {
        return json({
          ok: true,
          ...(await listClients(env, {
            page: num(url.searchParams.get('page')),
            pageSize: num(url.searchParams.get('pageSize')) || s.int('page_size', 25),
            search: url.searchParams.get('search') ?? '',
            inboundId: num(url.searchParams.get('inbound')),
            status: (url.searchParams.get('status') ?? 'all') as never,
            sort: url.searchParams.get('sort') ?? 'id',
            dir: (url.searchParams.get('dir') ?? 'desc') as 'asc' | 'desc',
          })),
        });
      }
      if (req.method === 'POST' && !a) {
        const out = await createClient(env, await readJson(req));
        return json({ ok: true, ...out }, 201);
      }
      if (req.method === 'POST' && a === 'bulk') {
        return json({ ok: true, ...(await bulkCreate(env, await readJson(req))) }, 201);
      }
      if (req.method === 'POST' && a === 'reset') {
        const body = await readJson<{ ids?: number[] }>(req);
        return json({ ok: true, changed: await resetUsageOf(env, body.ids ?? []) });
      }
      if (req.method === 'POST' && a === 'renew') {
        const body = await readJson<{ ids?: number[]; days?: number; reset?: boolean }>(req);
        return json({ ok: true, changed: await renewClients(env, body.ids ?? [], body.days ?? 30, body.reset === true) });
      }
      if (req.method === 'DELETE' && a === 'bulk') {
        const body = await readJson<{ ids?: number[] }>(req);
        return json({ ok: true, deleted: await deleteClients(env, body.ids ?? []) });
      }

      const id = num(a);
      if (!id) throw new HttpError(400, 'شناسه‌ی کاربر نامعتبر');
      // لینک‌ها و QR — QR همین‌جا (سرور) ساخته می‌شود، نه با سرویس بیرونی، چون
      // محتوایش دقیقاً همان لینک اشتراکی است که کل پنل برای مخفی‌ماندنش ساخته شده.
      if (req.method === 'GET' && b === 'sub') {
        const entry = byClientId(await clientIndex(env), id);
        if (!entry) throw new HttpError(404, 'کاربر پیدا نشد');
        const built = await buildFor(env, s, entry, new URL(req.url));
        return json({
          ok: true,
          sub_url: built.subUrl,
          links: built.links,
          qr: qrSvg(built.subUrl, { ecc: 'M', margin: 2 }),
          usage: built.usage,
        });
      }
      if (req.method === 'GET') return json({ ok: true, client: await getClient(env, id) });
      if (req.method === 'PUT') {
        await updateClient(env, id, await readJson(req));
        return json({ ok: true });
      }
      if (req.method === 'DELETE') return json({ ok: true, deleted: await deleteClients(env, [id]) });
      if (req.method === 'POST' && b === 'rotate-sub') return json({ ok: true, sub_token: await rotateSubToken(env, id) });
      if (req.method === 'POST' && b === 'rotate-auth') return json({ ok: true, auth: await rotateAuth(env, id) });
      if (req.method === 'POST' && b === 'clear-ips') {
        await clearIps(env, id);
        return json({ ok: true });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── inboundها
    case 'inbounds': {
      if (req.method === 'GET') return json({ ok: true, inbounds: await listInbounds(env) });
      if (req.method === 'POST') return json({ ok: true, ...(await saveInbound(env, await readJson(req))) }, 201);
      if (req.method === 'PUT') {
        const id = num(a);
        if (!id) throw new HttpError(400, 'شناسه نامعتبر');
        return json({ ok: true, ...(await saveInbound(env, { ...(await readJson<object>(req)), id })) });
      }
      if (req.method === 'DELETE') {
        const id = num(a);
        if (!id) throw new HttpError(400, 'شناسه نامعتبر');
        return json({ ok: true, deleted: await deleteInbound(env, id) });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── نودها
    case 'nodes': {
      if (req.method === 'GET') return json({ ok: true, nodes: await listNodes(env) });
      if (req.method === 'POST' && a === 'token') {
        const body = await readJson<{ name?: string }>(req);
        return json({ ok: true, ...(await nodeToken(env, s, body.name ?? '')) });
      }
      if (req.method === 'POST') return json({ ok: true, ...(await saveNode(env, s, await readJson(req))) }, 201);
      if (req.method === 'PUT') {
        const id = num(a);
        if (!id) throw new HttpError(400, 'شناسه نامعتبر');
        return json({ ok: true, ...(await saveNode(env, s, { ...(await readJson<object>(req)), id })) });
      }
      if (req.method === 'DELETE') {
        const id = num(a);
        if (!id) throw new HttpError(400, 'شناسه نامعتبر');
        return json({ ok: true, deleted: await deleteNode(env, id) });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── تنظیمات
    case 'settings': {
      if (req.method === 'GET') return json({ ok: true, settings: exportSettings(s) });
      if (req.method === 'PUT') {
        const body = await readJson<Record<string, unknown>>(req);
        const entries: Record<string, string> = {};
        for (const [k, v] of Object.entries(body)) {
          // کلیدهای حساس فقط از مسیر خودشان عوض می‌شوند.
          if (k === 'admin_pass_hash' || k === 'panel_path') continue;
          // مقدار ماسک‌شده‌ی برگشتی از UI هرگز نباید دوباره نوشته شود.
          if (typeof v === 'string' && v === '••••••••') continue;
          entries[k] = typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? '1' : '0') : JSON.stringify(v);
        }
        await setSettings(env, entries);
        invalidateClients();
        return json({ ok: true });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    case 'password': {
      if (req.method !== 'POST') throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
      const body = await readJson<{ old?: string; new?: string }>(req);
      const ok = await changePassword(env, s, body.old ?? '', body.new ?? '');
      return ok ? json({ ok: true }) : json({ ok: false, error: 'رمز فعلی اشتباه است یا رمز جدید کوتاه است' }, 400);
    }

    case 'panel-path': {
      if (req.method !== 'POST') throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
      const body = await readJson<{ path?: string }>(req);
      const p = (body.path ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!/^[A-Za-z0-9._-]{6,64}$/.test(p)) throw new HttpError(400, 'مسیر باید ۶ تا ۶۴ کاراکتر و بدون «/» باشد');
      await setSettings(env, { panel_path: p });
      return json({ ok: true, path: p });
    }

    case 'audit': {
      const rows = await env.DB.prepare('SELECT at, kind, actor, ip, detail FROM audit_log ORDER BY id DESC LIMIT 200').all<
        Record<string, unknown>
      >();
      return json({ ok: true, rows: rows.results ?? [] });
    }

    // ── کلیدهای API — پل اتصال ربات تلگرام (و اتوماسیون بیرونی در آینده)
    case 'keys': {
      if (req.method === 'GET') return json({ ok: true, keys: await listKeys(env) });
      if (req.method === 'POST') {
        const body = await readJson<{ name?: string; scope?: string }>(req);
        const scope: KeyScope = body.scope === 'write' || body.scope === 'tg' ? body.scope : 'read';
        return json({ ok: true, ...(await createKey(env, body.name ?? '', scope)) }, 201);
      }
      if (req.method === 'DELETE' && a) {
        await deleteKey(env, num(a));
        return json({ ok: true });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── ربات تلگرام: اتصال = ثبت وب‌هوک + کلید یک‌بارمصرفِ بایند
    case 'telegram': {
      if (req.method === 'POST' && a === 'connect') {
        const token = s.get('tg_bot_token');
        if (!token) throw new HttpError(400, 'اول توکن ربات را در همین صفحه ذخیره کنید');
        const info = await botInfo(token);
        if (!info.ok) throw new HttpError(400, 'توکن ربات نامعتبر است');
        const out = await setWebhook(env, s, url.origin);
        if (!out.ok) throw new HttpError(400, out.error ?? 'ثبت وب‌هوک ناموفق بود');
        const key = await createKey(env, 'tg-bind', 'tg');
        return json({ ok: true, username: info.username ?? '', api_key: key.key });
      }
      if (req.method === 'POST' && a === 'unbind') {
        await deleteWebhook(s);
        await setSettings(env, { tg_bound_chat: '', tg_bound_name: '' });
        return json({ ok: true });
      }
      if (req.method === 'GET') {
        const token = s.get('tg_bot_token');
        return json({
          ok: true,
          bound: Boolean(s.get('tg_bound_chat')),
          bound_name: s.get('tg_bound_name'),
          bot: token ? await botInfo(token) : null,
        });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── ورود دومرحله‌ای (TOTP)
    case 'twofa': {
      if (req.method === 'POST' && a === 'setup') {
        // رمز جدید می‌سازیم ولی فعال نمی‌کنیم — فعال‌سازی فقط بعد از تأیید کد
        const secret = newTotpSecret();
        await setSettings(env, { twofa_secret: secret, twofa_enabled: '0' });
        const url = otpauthUrl(secret, s.get('admin_user') || 'admin');
        return json({ ok: true, secret, otpauth: url, qr: qrSvg(url, { size: 168 }) });
      }
      if (req.method === 'POST' && a === 'enable') {
        const body = await readJson<{ code?: string }>(req);
        const secret = s.get('twofa_secret');
        if (!secret) throw new HttpError(400, 'اول «راه‌اندازی ۲FA» را بزنید');
        if (!(await verifyTotp(secret, body.code ?? ''))) {
          return json({ ok: false, error: 'کد اشتباه است — با اپ چک کن' }, 400);
        }
        await setSettings(env, { twofa_enabled: '1' });
        return json({ ok: true });
      }
      if (req.method === 'POST' && a === 'disable') {
        const body = await readJson<{ code?: string }>(req);
        const secret = s.get('twofa_secret');
        // خاموش‌کردن هم کد فعال می‌خواهد تا هرکسی که پنل را باز دارد نتواند قفل را بردارد.
        if (secret && s.bool('twofa_enabled') && !(await verifyTotp(secret, body.code ?? ''))) {
          return json({ ok: false, error: 'کد اشتباه است' }, 400);
        }
        await setSettings(env, { twofa_enabled: '0', twofa_secret: '' });
        return json({ ok: true });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── پشتیبان‌گیری
    case 'backup': {
      if (req.method === 'GET') {
        const data = await exportBackup(env);
        return new Response(JSON.stringify(data), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="persianpl-backup-${new Date().toISOString().slice(0, 10)}.json"`,
            'cache-control': 'no-store',
          },
        });
      }
      if (req.method === 'POST' && a === 'restore') {
        const body = await readJson<unknown>(req);
        const out = await restoreBackup(env, body);
        if (!out.ok) throw new HttpError(400, out.error);
        return json({ ok: true, restored: out.restored });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    case 'cron': {
      if (req.method !== 'POST') throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
      return json({ ok: true, report: await runCron(env) });
    }

    // ── پروفایل‌های مسیریابی (قاعده‌ی اختصاصی هر کاربر)
    case 'routing': {
      if (req.method === 'GET') return json({ ok: true, profiles: await listProfiles(env) });
      if (req.method === 'POST' && !a) {
        const body = await readJson<{ name?: string; rules?: Record<string, unknown> }>(req);
        const p = await createProfile(env, body.name ?? '', (body.rules ?? {}) as never);
        return json({ ok: true, profile: p }, 201);
      }
      if (req.method === 'POST' && a === 'default' && b) {
        await setDefaultProfile(env, num(b));
        return json({ ok: true });
      }
      if (req.method === 'POST' && b) {
        const body = await readJson<{ name?: string; rules?: Record<string, unknown> }>(req);
        await updateProfile(env, num(b), { name: body.name, rules: (body.rules ?? undefined) as never });
        return json({ ok: true });
      }
      if (req.method === 'DELETE' && a) {
        await deleteProfile(env, num(a));
        return json({ ok: true });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── WARP: ثبت هویت وایرگارد از API کلادفلر + دانلود .conf
    case 'warp': {
      if (req.method === 'POST' && a === 'register') {
        try {
          const id = await registerWarp();
          await setSettings(env, { warp_identity: JSON.stringify(id) });
          return json({ ok: true, endpoint: id.endpoint, v4: id.v4, peer: id.peer });
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : 'خطای ثبت WARP' }, 502);
        }
      }
      if (req.method === 'POST' && a === 'remove') {
        await setSettings(env, { warp_identity: '', warp_enabled: '0' });
        return json({ ok: true });
      }
      if (req.method === 'GET' && a === 'conf') {
        const id = parseIdentity(s.get('warp_identity'));
        if (!id) throw new HttpError(404, 'هویت WARP ثبت نشده است');
        return new Response(wireguardConf(id, s.get('sub_title')), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="warp.conf"',
            'cache-control': 'no-store',
          },
        });
      }
      if (req.method === 'GET') {
        const id = parseIdentity(s.get('warp_identity'));
        return json({
          ok: true,
          enabled: s.bool('warp_enabled'),
          mode: s.get('warp_mode'),
          sites: s.get('warp_sites'),
          registered: Boolean(id),
          endpoint: id?.endpoint ?? '',
        });
      }
      throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
    }

    // ── ایمپورت از x-ui / 3x-ui
    case 'import-xui': {
      if (req.method !== 'POST') throw new HttpError(405, 'متد پشتیبانی نمی‌شود');
      const body = await readJson<unknown>(req);
      const out = await importXui(env, body);
      if (!out.ok) return json({ ok: false, error: out.warnings[0] ?? 'ایمپورت ناموفق بود' }, 400);
      return json({
        ok: true,
        inbounds: out.inbounds,
        clients: out.clients,
        skipped: out.skipped,
        warnings: out.warnings,
      });
    }

    case 'whoami':
      return json({ ok: true, user: s.get('admin_user'), ip });

    default:
      throw new HttpError(404, 'مسیر ناشناس');
  }
}

/** تنظیمات را برای UI بیرون می‌دهد — با حذف مقادیر حساس. */
function exportSettings(s: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  const hidden = new Set(['admin_pass_hash', 'twofa_secret', 'node_secret', 'cf_api_token', 'tg_bot_token', 'tg_webhook_secret']);
  for (const k of SETTING_KEYS) {
    out[k] = hidden.has(k) ? (s.get(k) ? '••••••••' : '') : s.get(k);
  }
  return out;
}

/** کلیدهایی که UI نمایش می‌دهد (ترتیبش همان ترتیب فرم است). */
const SETTING_KEYS = [
  'panel_path', 'admin_user', 'session_max_age', 'page_size', 'lang', 'theme', 'calendar',
  'ip_limit_enable', 'twofa_enabled',
  'decoy_mode', 'decoy_target',
  'sub_path', 'sub_title', 'sub_update_interval', 'sub_show_info', 'remark_template',
  'remark_separator', 'fake_configs', 'max_configs', 'external_subs',
  'proxyip', 'proxyip_mode', 'nat64_prefixes', 'socks5', 'socks5_global', 'socks5_domains',
  'dynamic_paths', 'clean_ips', 'clean_ips_url', 'custom_cdn',
  'dial_parallel', 'dial_timeout', 'idle_timeout', 'dns_relay',
  'bypass_iran', 'bypass_lan', 'block_ads', 'block_porn', 'block_quic',
  'custom_rules_direct', 'custom_rules_block', 'custom_rules_proxy',
  'warp_enabled', 'warp_mode', 'warp_sites',
  'dns_remote', 'dns_local', 'dns_underlying_doh', 'doh_enable', 'fakedns', 'ipv6',
  'default_gen_opts',
  'node_secret', 'node_pull_interval',
  'tg_bot_token', 'tg_chat_id', 'tg_notify_expiry', 'tg_notify_traffic', 'tg_notify_login',
  'tg_webhook_secret', 'tg_bound_chat', 'tg_bound_name',
  'kill_switch', 'cf_api_token', 'cf_account_id',
];

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'بدنه‌ی JSON نامعتبر');
  }
}

function num(v: string | null | undefined): number {
  const n = Number(v ?? '');
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function json(v: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      // پنل هیچ اسکریپت یا استایل بیرونی ندارد؛ inline لازم است چون همه‌چیز
      // در همان صفحه سرو می‌شود.
      'content-security-policy':
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
    },
  });
}

