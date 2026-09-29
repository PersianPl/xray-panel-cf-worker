/**
 * احراز هویت پنل: ورود با رمز، نشست کوکی، و بوت‌استرپ اولین اجرا.
 *
 * طرح:
 *   • رمز با PBKDF2-SHA256 (۲۱۰k تکرار) در `settings.admin_pass_hash` است
 *   • توکن نشست ۳۲ بایت تصادفی است؛ در D1 فقط **هش** آن ذخیره می‌شود تا دسترسی
 *     خواندنی به دیتابیس اجازه‌ی جعل نشست ندهد
 *   • کوکی `HttpOnly; Secure; SameSite=Strict` و مسیرش همان مسیر مخفی پنل است
 *   • تلاش‌های ناموفق با تأخیر تصاعدی در سطح isolate کند می‌شوند (D1 نمی‌نویسیم
 *     که سهمیه نسوزد)
 */
import { hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { loadSettings, setSettings, type Settings } from '../lib/settings';
import { verifyTotp } from '../lib/totp';
import { esc, tgNotify } from '../tg/bot';
import type { Env } from '../types';

const COOKIE = 'pp_sess';
/** بعد از این تعداد شکست، هر تلاش ۲ ثانیه تأخیر می‌گیرد. */
const LOCK_AFTER = 5;
const LOCK_DELAY_MS = 2000;

const failures = new Map<string, { n: number; at: number }>();
const FAIL_WINDOW_MS = 15 * 60_000;

export interface Session {
  token: string;
  expiresAt: number;
}

/**
 * اولین اجرا: مسیر مخفی و رمز ادمین را می‌سازد.
 *
 * مسیر و رمز از `env` خوانده می‌شوند اگر ست شده باشند (برای استقرار خودکار)،
 * وگرنه تولید می‌شوند و **یک‌بار** در لاگ چاپ می‌شوند. رمزِ خام هیچ‌جا ذخیره
 * نمی‌شود.
 */
export async function bootstrap(env: Env): Promise<{ created: boolean; path: string; password?: string }> {
  const map = await loadSettings(env, true);
  const havePath = (map.get('panel_path') ?? '').length > 0;
  const haveHash = (map.get('admin_pass_hash') ?? '').length > 0;
  if (havePath && haveHash) return { created: false, path: map.get('panel_path')! };

  const path = havePath ? map.get('panel_path')! : (env.PANEL_PATH?.trim() || randomId(14));
  const entries: Record<string, string> = { panel_path: path };
  let password: string | undefined;

  if (!haveHash) {
    password = env.ADMIN_PASS?.trim() || randomToken(12);
    entries.admin_pass_hash = await hashPassword(password);
    entries.admin_user = env.ADMIN_USER?.trim() || map.get('admin_user') || 'admin';
  }

  await setSettings(env, entries);
  return { created: true, path, ...(password ? { password } : {}) };
}

/** ورود؛ در صورت موفقیت کوکی نشست را برمی‌گرداند. */
export async function login(
  env: Env,
  s: Settings,
  user: string,
  pass: string,
  code: string,
  meta: { ip: string; ua: string; secure?: boolean },
): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> {
  const f = failures.get(meta.ip);
  if (f && Date.now() - f.at < FAIL_WINDOW_MS && f.n >= LOCK_AFTER) {
    await sleep(LOCK_DELAY_MS);
  }

  const hash = s.get('admin_pass_hash');
  const okUser = user === s.get('admin_user');
  // رمز را همیشه بررسی می‌کنیم، حتی با کاربر غلط، تا زمان پاسخ نام کاربری را لو ندهد.
  const okPass = hash ? await verifyPassword(pass, hash) : false;

  if (!okUser || !okPass) {
    noteFailure(meta.ip);
    await audit(env, 'login_fail', user, meta.ip, 'رمز یا نام کاربری اشتباه');
    return { ok: false, reason: 'نام کاربری یا رمز عبور اشتباه است' };
  }

  // ── ورود دومرحله‌ای (TOTP)
  // اگر enabled ولی secret خالی است یعنی پیکربندی دستی خراب شده — قفل نکنیم
  // (fail-open) وگرنه ادمین بیرون پنل می‌ماند؛ در لاگ هشدار می‌ماند.
  if (s.bool('twofa_enabled')) {
    const secret = s.get('twofa_secret');
    if (!secret) {
      console.error('twofa_enabled=1 اما twofa_secret خالی است — بررسی ۲FA نادیده گرفته شد');
    } else if (!(await verifyTotp(secret, code))) {
      noteFailure(meta.ip);
      await audit(env, 'login_fail', user, meta.ip, 'کد TOTP اشتباه');
      return { ok: false, reason: 'کد دومرحله‌ای اشتباه است' };
    }
  }

  failures.delete(meta.ip);
  const token = randomToken(32);
  const maxAge = Math.max(300, s.int('session_max_age', 86400));
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare('INSERT INTO sessions (token, ip, ua, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), meta.ip, meta.ua.slice(0, 200), now, now + maxAge)
    .run();
  await audit(env, 'login', user, meta.ip, 'ورود موفق');

  // اطلاع‌رسانی به چت بایندشده — tgNotify هرگز نمی‌شکند، پس جلوی ورود را نمی‌گیرد.
  if (s.bool('tg_notify_login') && s.get('tg_bound_chat')) {
    await tgNotify(env, s, `🔐 ورود موفق به پنل — <b>${esc(user)}</b>\nIP: <code>${esc(meta.ip)}</code>`);
  }

  return { ok: true, cookie: cookieHeader(token, maxAge, s.get('panel_path'), meta.secure ?? false) };
}

function noteFailure(ip: string): void {
  const f = failures.get(ip);
  if (f && Date.now() - f.at < FAIL_WINDOW_MS) {
    f.n++;
    f.at = Date.now();
  } else {
    failures.set(ip, { n: 1, at: Date.now() });
  }
}

/** نشست را از کوکی می‌سنجد. `null` یعنی وارد نشده. */
export async function currentSession(env: Env, req: Request): Promise<{ token: string } | null> {
  const raw = readCookie(req.headers.get('cookie'), COOKIE);
  if (!raw) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT token FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(await sha256Hex(raw), now)
    .first<{ token: string }>();
  return row ? { token: raw } : null;
}

export async function logout(env: Env, req: Request, s: Settings): Promise<string> {
  const raw = readCookie(req.headers.get('cookie'), COOKIE);
  if (raw) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256Hex(raw)).run();
  return cookieHeader('', 0, s.get('panel_path'), isSecureRequest(req));
}

/** رمز ادمین را عوض می‌کند و همه‌ی نشست‌های دیگر را می‌بندد. */
export async function changePassword(env: Env, s: Settings, oldPass: string, newPass: string): Promise<boolean> {
  const hash = s.get('admin_pass_hash');
  if (!hash || !(await verifyPassword(oldPass, hash))) return false;
  if (newPass.length < 8) return false;
  await setSettings(env, { admin_pass_hash: await hashPassword(newPass) });
  // تغییر رمز باید همه‌ی نشست‌ها را باطل کند، وگرنه سرقتِ کوکی با تغییر رمز حل نمی‌شود.
  await env.DB.prepare('DELETE FROM sessions').run();
  return true;
}

function cookieHeader(token: string, maxAge: number, panelPath: string, secure: boolean): string {
  const path = panelPath ? `/${panelPath}` : '/';
  // `Secure` فقط روی HTTPS: مرورگرها کوکی Secure را روی http (مثل wrangler dev
  // لوکال) دور می‌ریزند و پنل بعد از لاگین کاملاً از کار می‌افتد.
  const parts = [`${COOKIE}=${token}`, `Path=${path}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secure) parts.splice(3, 0, 'Secure');
  return parts.join('; ');
}

/** آیا درخواست روی HTTPS است؟ (پشت CF واقعی → https؛ wrangler dev لوکال → http) */
export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return proto === 'https';
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function audit(env: Env, kind: string, actor: string, ip: string, detail: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO audit_log (kind, actor, ip, detail) VALUES (?, ?, ?, ?)')
      .bind(kind, actor, ip, detail.slice(0, 500))
      .run();
  } catch {
    // لاگ نباید عملیات را بشکند
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const SESSION_COOKIE = COOKIE;
