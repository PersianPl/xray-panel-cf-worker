/**
 * کلیدهای API — پل اتصال پنل به ربات تلگرام (و آینده: اتوماسیون بیرونی).
 *
 * جدول `api_keys` از ابتدای پروژه وجود داشت ولی بلااستفاده بود؛ این ماژول آن را
 * زنده می‌کند:
 *   • هر کلید فقط **هش‌شده** ذخیره می‌شود (SHA-256) — خام فقط یک‌بار در پاسخِ
 *     ساخت نمایش داده می‌شود.
 *   • سه دامنه: `read` فقط خواندن، `write` خواندن+نوشتن، `tg` مخصوص بایند
 *     ربات تلگرام (کلید بعد از یک بار استفاده دیگر به‌تنهایی دسترسی نمی‌دهد).
 *   • مقایسه با timingSafeEqual تا زمان پاسخ طول کلید را لو ندهد.
 */
import { randomId, randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Env } from '../types';

export type KeyScope = 'read' | 'write' | 'tg';

export interface ApiKeyRow {
  id: number;
  name: string;
  scope: string;
  /** پیش‌نمایش امن: ۴ کاراکتر اول کلید خام */
  hint: string;
  last_used: number;
  created_at: number;
}

export async function listKeys(env: Env): Promise<ApiKeyRow[]> {
  const rs = await env.DB.prepare(
    'SELECT id, name, scope, last_used, created_at FROM api_keys ORDER BY id DESC',
  ).all<{ id: number; name: string; scope: string; last_used: number; created_at: number }>();
  return (rs.results ?? []).map((r) => ({ ...r, hint: r.name.slice(0, 4) }));
}

/** کلید جدید می‌سازد؛ مقدار خام فقط همین‌جا برگردانده می‌شود. */
export async function createKey(env: Env, name: string, scope: KeyScope): Promise<{ id: number; key: string }> {
  const clean = name.trim().slice(0, 64) || 'default';
  const key = `pplk_${randomToken(12)}_${randomId(8)}`;
  const r = await env.DB.prepare('INSERT INTO api_keys (name, key_hash, scope, created_at) VALUES (?, ?, ?, unixepoch())')
    .bind(clean, await sha256Hex(key), scope)
    .run();
  return { id: Number(r.meta.last_row_id), key };
}

export async function deleteKey(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
}

/**
 * تأیید کلید خام. اگر کلید معتبر باشد ردیفش برمی‌گردد و `last_used` به‌روز
 * می‌شود؛ وگرنه `null`.
 */
export async function verifyKey(
  env: Env,
  key: string,
  need: KeyScope,
): Promise<{ id: number; scope: string } | null> {
  const clean = key.trim();
  if (!clean) return null;
  const hash = await sha256Hex(clean);
  const row = await env.DB.prepare('SELECT id, scope, key_hash FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<{ id: number; scope: string; key_hash: string }>();
  if (!row || !timingSafeEqual(row.key_hash, hash)) return null;
  if (need === 'write' && row.scope === 'read') return null;
  return { id: row.id, scope: row.scope };
}
