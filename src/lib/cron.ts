/**
 * کارهای دوره‌ای (Cron هر ۵ دقیقه).
 *
 * چهار کار:
 *   1. تمدید خودکار: کاربرانی که `renew_days` دارند و منقضی شده‌اند
 *   2. ریست دوره‌ای ترافیک inbound (روزانه/هفتگی/ماهانه)
 *   3. پاک‌سازی: نشست‌های منقضی، IPهای قدیمی، آمار روزانه‌ی کهنه، لاگ حجیم
 *   4. سلامت نودها: نودی که بیش از دو بازه‌ی pull بی‌خبر است `stale`/`down` می‌شود
 *
 * همه‌ی کوئری‌ها مجموعه‌ای‌اند (نه per-row) تا از سقف ۵۰ کوئریِ D1 در هر
 * invocation فاصله بگیریم. `runCron` در بدترین حالت ۱۲ عبارت اجرا می‌کند.
 */
import { settings, setSetting, type Settings } from './settings';
import { tgNotify } from '../tg/bot';
import type { Env } from '../types';

/** آمار روزانه بیش از این تعداد روز نگه داشته نمی‌شود (فضای D1 روی Free محدود است). */
const KEEP_DAYS = 90;
/** سقف ردیف لاگ حسابرسی. */
const KEEP_AUDIT = 5000;

export interface CronReport {
  renewed: number;
  resetInbounds: number;
  staleNodes: number;
}

export async function runCron(env: Env): Promise<CronReport> {
  const now = Math.floor(Date.now() / 1000);
  const s = await settings(env);

  const renewed = await renewExpired(env, now);
  const resetInbounds = await resetTraffic(env, now);
  const staleNodes = await markNodes(env, now, s.int('node_pull_interval', 300));
  await cleanup(env, now);

  // اعلان‌های تلگرام — هرگز نباید کران را بشکنند (tgNotify خودش بی‌صدا شکست می‌خورد).
  if (renewed > 0) {
    await tgNotify(env, s, `🔄 <b>${renewed}</b> کاربر منقضی به‌صورت خودکار تمدید شد.`);
  }
  await notifyWarnings(env, s, now);

  return { renewed, resetInbounds, staleNodes };
}

/**
 * هشدارهای نزدیک‌شدن انقضا (≤ ۳ روز) و اتمام حجم (≥ ۹۰٪) + گزارش روزانه.
 * برای جلوگیری از اسپم، هر هشدار فقط یک‌بار در روز فرستاده می‌شود — ممیزِ
 * «روز» همان `tg_last_digest` است که ساعتِ آخرین ارسال را نگه می‌دارد.
 */
const WARN_HORIZON_SEC = 3 * 86400;
const WARN_TRAFFIC_RATIO = 0.9;
const WARN_GB = 1024 ** 3;

async function notifyWarnings(env: Env, s: Settings, now: number): Promise<void> {
  const last = Number(s.get('tg_last_digest')) || 0;
  if (now - last < 20 * 3600) return; // یک‌بار در روز کافی است

  const lines: string[] = [];

  if (s.bool('tg_notify_expiry')) {
    const horizon = now + WARN_HORIZON_SEC;
    const rs = await env.DB.prepare(
      'SELECT name, expiry_at FROM clients WHERE enable = 1 AND expiry_at > ? AND expiry_at <= ? ORDER BY expiry_at LIMIT 20',
    )
      .bind(now, horizon)
      .all<{ name: string; expiry_at: number }>();
    for (const r of rs.results ?? []) {
      const days = Math.max(1, Math.ceil((r.expiry_at - now) / 86400));
      lines.push(`⏳ <b>${escName(r.name)}</b> تا ${days} روز دیگر منقضی می‌شود`);
    }
  }

  if (s.bool('tg_notify_traffic')) {
    const rs = await env.DB.prepare(
      'SELECT name, total_gb, up, down FROM clients WHERE enable = 1 AND total_gb > 0 AND (up + down) >= total_gb * ? ORDER BY (up + down) DESC LIMIT 20',
    )
      .bind(WARN_TRAFFIC_RATIO)
      .all<{ name: string; total_gb: number; up: number; down: number }>();
    for (const r of rs.results ?? []) {
      lines.push(`📦 <b>${escName(r.name)}</b> مصرفش به ${Math.round(((r.up + r.down) / (r.total_gb * WARN_GB)) * 100)}٪ رسیده`);
    }
  }

  if (lines.length) {
    await tgNotify(env, s, ['<b>🔔 هشدارهای امروز</b>', '', ...lines].join('\n'));
  }
  await setSetting(env, 'tg_last_digest', String(now));
}

/** escape نام برای پیام HTML — نسخه‌ی کوچک محلی تا وابستگی چرخشی نشود. */
function escName(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * تمدید خودکار: انقضا +`renew_days` روز جلو می‌رود و مصرف صفر می‌شود.
 *
 * مبنا `expiry_at` است نه «الان»، تا اگر Cron چند بار جا افتاده باشد تاریخ‌ها
 * نلغزند؛ ولی اگر بیش از یک دوره عقب افتاده باشیم، `MAX(...)` جلو می‌آورد تا
 * کاربر بی‌جهت هنوز منقضی نماند.
 */
async function renewExpired(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE clients
        SET expiry_at = MAX(expiry_at + renew_days * 86400, ? + renew_days * 86400),
            up = 0, down = 0,
            reset_count = reset_count + 1
      WHERE renew_days > 0 AND expiry_at > 0 AND expiry_at <= ?`,
  )
    .bind(now, now)
    .run();
  return r.meta.changes ?? 0;
}

/** ریست دوره‌ای ترافیک inbound بر اساس `traffic_reset`. */
async function resetTraffic(env: Env, now: number): Promise<number> {
  const periods: Array<[string, number]> = [
    ['daily', 86400],
    ['weekly', 7 * 86400],
    ['monthly', 30 * 86400],
  ];
  let changed = 0;
  for (const [kind, span] of periods) {
    const r = await env.DB.prepare(
      'UPDATE inbounds SET up = 0, down = 0, last_reset_at = ? WHERE traffic_reset = ? AND last_reset_at <= ?',
    )
      .bind(now, kind, now - span)
      .run();
    changed += r.meta.changes ?? 0;
  }
  return changed;
}

/**
 * سلامت نودها از آخرین pull حساب می‌شود:
 *   • ≤ ۲ بازه → ok
 *   • ≤ ۶ بازه → stale
 *   • بیشتر     → down
 */
async function markNodes(env: Env, now: number, interval: number): Promise<number> {
  const stale = now - interval * 2;
  const down = now - interval * 6;
  const r = await env.DB.prepare(
    `UPDATE nodes
        SET health = CASE
              WHEN last_seen = 0      THEN 'unknown'
              WHEN last_seen > ?      THEN 'ok'
              WHEN last_seen > ?      THEN 'stale'
              ELSE 'down' END
      WHERE enable = 1`,
  )
    .bind(stale, down)
    .run();
  return r.meta.changes ?? 0;
}

async function cleanup(env: Env, now: number): Promise<void> {
  const day = new Date((now - KEEP_DAYS * 86400) * 1000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM client_ips WHERE last_seen <= ?').bind(now - 86400),
    env.DB.prepare('DELETE FROM client_usage_daily WHERE day < ?').bind(day),
    env.DB.prepare(`DELETE FROM audit_log WHERE id <= (SELECT MAX(id) - ${KEEP_AUDIT} FROM audit_log)`),
    // شمارنده‌ی ریکوئستِ روزِ نودها در نیمه‌شب UTC صفر می‌شود.
    ...(new Date(now * 1000).getUTCHours() === 0 && new Date(now * 1000).getUTCMinutes() < 10
      ? [env.DB.prepare('UPDATE nodes SET req_today = 0')]
      : []),
  ]);
}
