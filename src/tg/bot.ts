/**
 * ربات تلگرام — مدیریت کامل پنل از داخل تلگرام.
 *
 * جریان اتصال (همان چیزی که کاربر می‌خواهد: «API Key پنل ⇄ ربات»):
 *   ۱. ادمین در پنل، توکن ربات را در تنظیمات ذخیره می‌کند
 *   ۲. در پنل «اتصال ربات» می‌زند → پنل secret وب‌هوک می‌سازد و setWebhook را
 *      روی خودش تنظیم می‌کند، و یک **API Key** با دامنه‌ی `tg` تولید می‌کند
 *   ۳. ادمین در تلگرام به ربات `/start <API_KEY>` می‌دهد → پنل چت را به‌عنوان
 *      چتِ مدیر بایند می‌کند (کلید مصرف می‌شود، دوباره نمی‌تواند بایند کند)
 *   ۴. از این پس هر دستور فقط از همان chat_id پاسخ می‌گیرد؛ پیام‌های دیگر چت‌ها
 *      بی‌صدا نادیده گرفته می‌شوند (نه رد ۴۰۳ — که وجود پنل را لو ندهد)
 *
 * محدودیت‌ها: پیام‌های قدیمی با `offset` دنبال نمی‌شوند؛ تلگرام هر آپدیت را
 * دقیقاً یک‌بار می‌فرستد و پاسخ ۲۰۰ ما تأیید دریافت است. خطای ارسال هرگز نباید
 * مسیر اصلی (cron/پنل) را بشکند.
 */
import { randomId, randomToken, sha256Hex, timingSafeEqual, uuidv4 } from '../lib/crypto';
import { setSettings, type Settings } from '../lib/settings';
import { dashboardStats } from '../panel/stats';
import { invalidateClients } from '../proxy/store';
import type { Env } from '../types';

const API = 'https://api.telegram.org';

export interface TgChat {
  id: number;
  first_name?: string;
  username?: string;
  title?: string;
}

export interface TgUpdate {
  update_id?: number;
  message?: { chat: TgChat; from?: TgChat; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: TgChat }; from?: TgChat };
}

/** فراخوانی Bot API؛ خطا هرگز بالا نرود چون تلگرام ۵۰۰ را retry می‌کند. */
export async function tgApi(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; description?: string } | null> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  } catch {
    return null;
  }
}

/** ارسال پیام متنی به یک چت. در صورت خطا بی‌صدا رد می‌شود. */
export async function tgSend(token: string, chatId: number | string, text: string, keyboard?: unknown): Promise<void> {
  await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * اعلان مدیریتی: اگر چت بایندشده و توکن ربات موجود باشد می‌فرستد.
 * همه‌ی نقاط دیگر پنل (cron، لاگین، هشدار ترافیک) فقط این تابع را صدا می‌زنند.
 */
export async function tgNotify(env: Env, s: Settings, text: string): Promise<boolean> {
  const token = s.get('tg_bot_token');
  const chat = s.get('tg_bound_chat');
  if (!token || !chat) return false;
  await tgSend(token, chat, text);
  return true;
}

/** secret وب‌هوک را (در صورت نبودن) می‌سازد — در URL و هدر هر دو استفاده می‌شود. */
export async function ensureWebhookSecret(env: Env, s: Settings): Promise<string> {
  const cur = s.get('tg_webhook_secret');
  if (cur) return cur;
  const secret = randomToken(16);
  await setSettings(env, { tg_webhook_secret: secret });
  return secret;
}

/** آدرس کامل وب‌هوک روی همین Worker. */
export function webhookUrl(origin: string, panelPath: string, secret: string): string {
  return `${origin.replace(/\/+$/, '')}/${panelPath}/api/telegram/webhook/${secret}`;
}

/**
 * ثبت وب‌هوک روی خودِ پنل. `allowed_updates` را محدود می‌کنیم تا تلگرام
 * چیزهای بی‌مصرف (ویرایش پیام و…) نفرستد.
 */
export async function setWebhook(env: Env, s: Settings, origin: string): Promise<{ ok: boolean; error?: string }> {
  const token = s.get('tg_bot_token');
  if (!token) return { ok: false, error: 'توکن ربات خالی است' };
  const secret = await ensureWebhookSecret(env, s);
  const url = webhookUrl(origin, s.get('panel_path'), secret);
  const out = await tgApi(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return out?.ok ? { ok: true } : { ok: false, error: out?.description ?? 'پاسخ نامعتبر از تلگرام' };
}

export async function deleteWebhook(s: Settings): Promise<void> {
  const token = s.get('tg_bot_token');
  if (token) await tgApi(token, 'deleteWebhook');
}

/** اطلاعات ربات برای نمایش در پنل. */
export async function botInfo(token: string): Promise<{ username?: string; ok: boolean }> {
  const out = await tgApi(token, 'getMe');
  const me = out?.result as { username?: string } | undefined;
  return { ok: Boolean(out?.ok), username: me?.username };
}

// ═══════════════════ وب‌هوک و دستورات ═══════════════════

const GB = 1024 ** 3;
/** تعداد کاربر در هر صفحه‌ی /users. */
const LIST_PAGE = 8;

const HELP = [
  '<b>🤖 PersianPl Panel Bot</b>',
  '',
  '/status — خلاصه‌ی وضعیت پنل',
  '/users — فهرست کاربران (با دکمه)',
  '/user &lt;نام یا شناسه&gt; — جزئیات یک کاربر',
  '/online — کاربران آنلاین (۵ دقیقه‌ی اخیر)',
  '/add &lt;نام&gt; [روز] [گیگابایت] — افزودن کاربر',
  '/kill on|off — قطع/وصل کل سرویس',
  '/help — همین راهنما',
].join('\n');

/** escape برای پیام‌های HTML — نام کاربر می‌تواند < داشته باشد. */
export function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** بایت خوانا — با cron مشترک است، برای همین export شده. */
export function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function isBound(s: Settings, chatId: number): boolean {
  return s.get('tg_bound_chat') === String(chatId);
}

function ok200(): Response {
  return new Response('ok', { status: 200 });
}

/**
 * ورودی وب‌هوک. احراز دو لایه: secret در مسیر و secret در هدرِ
 * `X-Telegram-Bot-Api-Secret-Token` — هر دو باید با `tg_webhook_secret`
 * برابر باشند. هر چیز دیگری ۴۰۳ می‌گیرد و به تلگرام چیزی نمی‌گوید.
 *
 * پاسخ همیشه ۲۰۰ است (جز ۴۰۳) تا تلگرام بی‌خود retry نکند؛ خطاهای داخلی
 * در لاگ Worker می‌مانند.
 */
export async function handleTgWebhook(req: Request, env: Env, s: Settings, secretInUrl: string): Promise<Response> {
  const secret = s.get('tg_webhook_secret');
  const header = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!secret || !timingSafeEqual(secretInUrl, secret) || !timingSafeEqual(header, secret)) {
    return new Response('forbidden', { status: 403 });
  }

  let up: TgUpdate;
  try {
    up = (await req.json()) as TgUpdate;
  } catch {
    return ok200();
  }

  const origin = new URL(req.url).origin;

  const cb = up.callback_query;
  if (cb?.message?.chat && typeof cb.message.chat.id === 'number') {
    if (isBound(s, cb.message.chat.id)) {
      try {
        await runCallback(env, s, cb.message.chat.id, cb.data ?? '', cb.id, origin);
      } catch (e) {
        console.error('tg callback', e instanceof Error ? e.stack : String(e));
      }
    }
    return ok200();
  }

  const msg = up.message;
  const text = msg?.text?.trim();
  if (msg?.chat && typeof msg.chat.id === 'number' && text) {
    try {
      await runCommand(env, s, msg.chat, text, origin);
    } catch (e) {
      console.error('tg command', e instanceof Error ? e.stack : String(e));
      await tgSend(s.get('tg_bot_token'), msg.chat.id, '⚠️ خطا در اجرای دستور.');
    }
  }
  return ok200();
}

async function runCommand(env: Env, s: Settings, chat: TgChat, text: string, origin: string): Promise<void> {
  const token = s.get('tg_bot_token');
  if (!token) return;

  const sp = text.indexOf(' ');
  const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase().split('@')[0]!;
  const rest = sp < 0 ? '' : text.slice(sp + 1).trim();

  // /start تنها دستورِ بدون بایند است — و تنها چیزی که بایند می‌کند.
  if (cmd === '/start') {
    await bindChat(env, s, chat, rest, token);
    return;
  }

  // چت ناشناس؟ بی‌صدا نادیده — نه ۴۰۳، نه پیام؛ وجود پنل لو نرود.
  if (!isBound(s, chat.id)) return;

  switch (cmd) {
    case '/help':
    case '/start@':
      await tgSend(token, chat.id, HELP);
      break;
    case '/status':
      await cmdStatus(env, s, chat.id, token);
      break;
    case '/users':
      await cmdUsers(env, s, chat.id, token, rest, 1);
      break;
    case '/user':
      await cmdUser(env, s, chat.id, token, rest, origin);
      break;
    case '/online':
      await cmdOnline(env, s, chat.id, token);
      break;
    case '/add':
      await cmdAdd(env, s, chat.id, token, rest, origin);
      break;
    case '/kill':
      await cmdKill(env, s, chat.id, token, rest);
      break;
    default:
      await tgSend(token, chat.id, 'دستور ناشناس است.\n\n' + HELP);
  }
}

/**
 * بایند چت مدیر با API Key: کلید با دامنه‌ی `tg` از پنل ساخته می‌شود، یک‌بار
 * در /start استفاده می‌شود و بلافاصله حذف می‌شود (دسترسی آینده فقط با
 * ترکیب توکن ربات + چت بایندشده معنا دارد).
 */
async function bindChat(env: Env, s: Settings, chat: TgChat, key: string, token: string): Promise<void> {
  const clean = key.trim();
  if (!clean) {
    await tgSend(
      token,
      chat.id,
      isBound(s, chat.id)
        ? '✅ این چت از قبل متصل است.\n\n' + HELP
        : 'سلام! برای اتصال پنل، کلید API را پس از /start بفرستید:\n<code>/start pplk_…</code>',
    );
    return;
  }
  if (s.get('tg_bound_chat')) {
    await tgSend(token, chat.id, '⚠️ یک چت از قبل متصل است. اول در پنل «لغو اتصال ربات» را بزنید.');
    return;
  }
  const hash = await sha256Hex(clean);
  const row = await env.DB.prepare('SELECT id, scope FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<{ id: number; scope: string }>();
  if (!row || row.scope !== 'tg') {
    await tgSend(token, chat.id, '❌ کلید نامعتبر است.');
    return;
  }
  const name = esc(chat.title || chat.username || chat.first_name || 'مدیر');
  await setSettings(env, { tg_bound_chat: String(chat.id), tg_bound_name: name });
  // کلید مصرف شد — دیگر با آن نمی‌شود چت دیگری را بایند کرد.
  await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(row.id).run();
  await tgSend(token, chat.id, `✅ متصل شد، ${name}!\nاز این پس می‌توانی پنل را کامل از همین‌جا مدیریت کنی.\n\n` + HELP);
}

// ─── دستورات ───

async function cmdStatus(env: Env, s: Settings, chatId: number, token: string): Promise<void> {
  const d = await dashboardStats(env, s);
  const nodes = d.nodes.length ? d.nodes.map((n) => `${healthEmoji(n.health)}${esc(n.name)}`).join(' · ') : '—';
  const cf =
    d.cf && d.cf.requests != null
      ? `\n☁️ سهمیه‌ی امروز CF: ${fmtNum(d.cf.requests)} / ${fmtNum(d.cf.limit)}`
      : '';
  await tgSend(
    token,
    chatId,
    [
      '<b>📊 وضعیت پنل</b>',
      '',
      `👥 کاربران: ${fmtNum(d.clients.total)} — فعال ${fmtNum(d.clients.active)} · آنلاین ${fmtNum(d.clients.online)}`,
      `⚠️ اتمام حجم ${fmtNum(d.clients.depleted)} · منقضی ${fmtNum(d.clients.expired)} · خاموش ${fmtNum(d.clients.disabled)}`,
      `📶 ترافیک کل: ↑${fmtBytes(d.traffic.up)} · ↓${fmtBytes(d.traffic.down)}`,
      `🖥 نودها: ${nodes}`,
      `⏻ Kill Switch: ${s.bool('kill_switch') ? 'روشن (سرویس قطع است!)' : 'خاموش'}${cf}`,
    ].join('\n'),
    {
      inline_keyboard: [
        [
          { text: '👥 کاربران', callback_data: 'p:1' },
          { text: '🔄 به‌روزرسانی', callback_data: 'st' },
        ],
      ],
    },
  );
}

async function cmdUsers(env: Env, s: Settings, chatId: number, token: string, rest: string, page: number): Promise<void> {
  const p = Math.max(1, Math.floor(Number(rest) || page || 1));
  const rs = await env.DB.prepare(
    'SELECT id, name, enable, total_gb, up, down, expiry_at FROM clients ORDER BY id LIMIT ? OFFSET ?',
  )
    .bind(LIST_PAGE + 1, (p - 1) * LIST_PAGE)
    .all<ListRow>();
  const rows = rs.results ?? [];
  const hasMore = rows.length > LIST_PAGE;
  const shown = rows.slice(0, LIST_PAGE);

  if (!shown.length) {
    await tgSend(token, chatId, p === 1 ? 'هنوز کاربری نیست.' : 'صفحه‌ی دیگری نیست.');
    return;
  }

  const lines = shown.map((r) => `${statusEmoji(r)} <b>${esc(r.name)}</b> — ${usageOf(r)}`);
  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < shown.length; i += 2) {
    kb.push(shown.slice(i, i + 2).map((r) => ({ text: r.name.slice(0, 16), callback_data: `m:${r.id}` })));
  }
  if (p > 1 || hasMore) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (p > 1) nav.push({ text: '◀️ قبلی', callback_data: `p:${p - 1}` });
    if (hasMore) nav.push({ text: 'بعدی ▶️', callback_data: `p:${p + 1}` });
    kb.push(nav);
  }

  await tgSend(token, chatId, `👥 <b>کاربران (صفحه‌ی ${fmtNum(p)})</b>\n\n${lines.join('\n')}`, { inline_keyboard: kb });
}

async function cmdUser(env: Env, s: Settings, chatId: number, token: string, rest: string, origin: string): Promise<void> {
  const q = rest.trim();
  if (!q) {
    await tgSend(token, chatId, 'به این شکل بفرست: <code>/user ali</code> یا <code>/user 3</code>');
    return;
  }
  const r = await findClient(env, q);
  if (!r) {
    await tgSend(token, chatId, 'کاربری با این نام یا شناسه پیدا نشد.');
    return;
  }
  await tgSend(token, chatId, card(r, s, origin), cardKb(r));
}

async function cmdOnline(env: Env, s: Settings, chatId: number, token: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rs = await env.DB.prepare(
    `SELECT c.id, c.name, c.up, c.down, c.total_gb, i.ip
       FROM clients c
       LEFT JOIN client_ips i ON i.client_id = c.id AND i.last_seen =
            (SELECT MAX(last_seen) FROM client_ips WHERE client_id = c.id)
      WHERE c.last_online > ?
      ORDER BY c.last_online DESC LIMIT 20`,
  )
    .bind(now - 300)
    .all<ListRow & { ip?: string }>();
  const rows = rs.results ?? [];
  if (!rows.length) {
    await tgSend(token, chatId, '💤 در ۵ دقیقه‌ی اخیر کسی آنلاین نبوده.');
    return;
  }
  const lines = rows.map((r) => `🟢 <b>${esc(r.name)}</b>${r.ip ? ` — <code>${esc(r.ip)}</code>` : ''} — ${usageOf(r)}`);
  await tgSend(token, chatId, `🟢 <b>آنلاین‌ها (${fmtNum(rows.length)})</b>\n\n${lines.join('\n')}`);
}

/**
 * افزودن کاربر از تلگرام: `/add ali 30 50` → نام ali، ۳۰ روز، ۵۰ گیگ.
 * inbound مقصد: اولین inbound فعال (برای انتخاب دقیق‌تر از پنل استفاده کن).
 */
async function cmdAdd(env: Env, s: Settings, chatId: number, token: string, rest: string, origin: string): Promise<void> {
  const parts = rest.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    await tgSend(token, chatId, 'به این شکل بفرست:\n<code>/add ali 30 50</code>\n(روز و گیگ اختیاری‌اند — صفر یعنی بی‌نهایت)');
    return;
  }
  const name = parts[0]!.slice(0, 64);
  const days = Math.max(0, Math.floor(Number(parts[1]) || 0));
  const gb = Math.max(0, Number(parts[2]) || 0);

  const ib = await env.DB.prepare('SELECT id, protocol FROM inbounds WHERE enable = 1 ORDER BY id LIMIT 1').first<{
    id: number;
    protocol: string;
  }>();
  if (!ib) {
    await tgSend(token, chatId, 'اول در پنل یک inbound فعال بساز.');
    return;
  }
  const auth = ib.protocol === 'vless' || ib.protocol === 'vmess' ? uuidv4() : randomId(12);
  const subToken = randomId(16);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      'INSERT INTO clients (inbound_id, name, auth, enable, total_gb, expiry_at, sub_token) VALUES (?,?,?,1,?,?,?)',
    )
      .bind(ib.id, name, auth, gb, days > 0 ? now + days * 86400 : 0, subToken)
      .run();
  } catch {
    await tgSend(token, chatId, '❌ ساختن نشد — احتمالاً نام تکراری است.');
    return;
  }
  invalidateClients();
  const sub = `${origin}/${s.get('sub_path')}/${subToken}`;
  await tgSend(
    token,
    chatId,
    [
      `✅ کاربر <b>${esc(name)}</b> ساخته شد.`,
      `⏳ انقضا: ${days > 0 ? `${fmtNum(days)} روز دیگر` : 'بدون انقضا'}`,
      `📦 حجم: ${gb > 0 ? `${fmtNum(gb)} گیگ` : 'بی‌نهایت'}`,
      `🔗 ساب: <code>${esc(sub)}</code>`,
      '',
      '<i>برای تنظیمات بیشتر (proxyip اختصاصی، پروفایل مسیریابی و…) از پنل استفاده کن.</i>',
    ].join('\n'),
  );
}

async function cmdKill(env: Env, s: Settings, chatId: number, token: string, rest: string): Promise<void> {
  const arg = rest.toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await tgSend(
      token,
      chatId,
      `⏻ Kill Switch الان: <b>${s.bool('kill_switch') ? 'روشن (سرویس قطع است)' : 'خاموش'}</b>\nبرای تغییر: <code>/kill on</code> یا <code>/kill off</code>`,
    );
    return;
  }
  await setSettings(env, { kill_switch: arg === 'on' ? '1' : '0' });
  invalidateClients();
  await tgSend(
    token,
    chatId,
    arg === 'on' ? '🛑 Kill Switch روشن شد — همه‌ی اتصال‌ها رد می‌شوند.' : '✅ Kill Switch خاموش شد — سرویس برگشت.',
  );
}

// ─── کمکی‌های نمایش ───

function fmtNum(n: number): string {
  return new Intl.NumberFormat('fa-IR').format(Math.max(0, Math.floor(n)));
}

function healthEmoji(h: string): string {
  return h === 'ok' ? '🟢' : h === 'stale' ? '🟡' : h === 'down' ? '🔴' : '⚪️';
}

/** ردیف کاربر برای فهرست و کارت. */
interface ListRow {
  id: number;
  name: string;
  enable: number;
  total_gb: number;
  up: number;
  down: number;
  expiry_at: number;
  delayed_days?: number;
  sub_token?: string;
  comment?: string;
  inbound_tag?: string;
  protocol?: string;
}

/** برچسب وضعیت برای فهرست‌ها. */
function statusEmoji(r: ListRow): string {
  if (!r.enable) return '⚪️';
  if (r.expiry_at > 0 && r.expiry_at <= Math.floor(Date.now() / 1000)) return '🔴';
  if (r.total_gb > 0 && r.up + r.down >= r.total_gb * GB) return '🟠';
  return '🟢';
}

/** مصرف خوانا: «۳٫۲ از ۵۰ گیگ» یا فقط بایت. */
function usageOf(r: ListRow): string {
  const used = r.up + r.down;
  return r.total_gb > 0 ? `${fmtBytes(used)} از ${fmtNum(r.total_gb)} گیگ` : fmtBytes(used);
}

// ─── کارت کاربر و کال‌بک‌ها ───

/** یافتن کاربر با شناسه‌ی عددی یا نام (تطبیق دقیق، بعد LIKE). */
async function findClient(env: Env, q: string): Promise<ListRow | null> {
  const base =
    'SELECT c.id, c.name, c.enable, c.total_gb, c.up, c.down, c.expiry_at, c.delayed_days, c.sub_token, c.comment, i.tag AS inbound_tag, i.protocol FROM clients c JOIN inbounds i ON i.id = c.inbound_id';
  if (/^\d+$/.test(q)) {
    const r = await env.DB.prepare(`${base} WHERE c.id = ?`).bind(Number(q)).first<ListRow>();
    if (r) return r;
  }
  return (
    (await env.DB.prepare(`${base} WHERE c.name = ?`).bind(q).first<ListRow>()) ??
    (await env.DB.prepare(`${base} WHERE c.name LIKE ? LIMIT 1`).bind(`%${q}%`).first<ListRow>()) ??
    null
  );
}

/** کارت کامل کاربر برای پیام تلگرام. */
function card(r: ListRow, s: Settings, origin: string): string {
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [`${statusEmoji(r)} <b>${esc(r.name)}</b>`, ''];
  if (r.comment) lines.push(`📝 ${esc(r.comment)}`);
  if (r.inbound_tag) lines.push(`🔌 inbound: ${esc(r.inbound_tag)} (${r.protocol ?? '?'})`);
  lines.push(`📶 مصرف: ↑${fmtBytes(r.up)} · ↓${fmtBytes(r.down)} — ${usageOf(r)}`);

  if (r.delayed_days && r.delayed_days > 0) {
    lines.push(
      `⏳ شروع تعویقی: ${fmtNum(r.delayed_days)} روز از اولین اتصال${
        r.expiry_at ? ` (تا ${new Date(r.expiry_at * 1000).toISOString().slice(0, 10)})` : ''
      }`,
    );
  } else {
    lines.push(
      `⏳ انقضا: ${
        r.expiry_at > 0
          ? new Date(r.expiry_at * 1000).toISOString().slice(0, 10) + (r.expiry_at <= now ? ' (منقضی!)' : '')
          : 'بدون انقضا'
      }`,
    );
  }
  lines.push(`🎚 وضعیت: ${r.enable ? 'فعال' : 'خاموش'}`);
  if (r.sub_token) {
    lines.push('', `🔗 ساب: <code>${esc(`${origin}/${s.get('sub_path')}/${r.sub_token}`)}</code>`);
  }
  return lines.join('\n');
}

/** دکمه‌های اکشن زیر کارت کاربر. */
function cardKb(r: ListRow): unknown {
  return {
    inline_keyboard: [
      [
        r.enable
          ? { text: '⏸ خاموش کن', callback_data: `t:${r.id}` }
          : { text: '▶️ روشن کن', callback_data: `t:${r.id}` },
        { text: '♻️ ریست حجم', callback_data: `r:${r.id}` },
      ],
      [
        { text: '+۳۰ روز', callback_data: `w:${r.id}:30` },
        { text: '+۹۰ روز', callback_data: `w:${r.id}:90` },
        { text: 'بی‌انقضا', callback_data: `e:${r.id}` },
      ],
      [{ text: '🗑 حذف کاربر', callback_data: `d:${r.id}` }],
    ],
  };
}

async function ack(token: string, cbId: string, text: string): Promise<void> {
  await tgApi(token, 'answerCallbackQuery', { callback_query_id: cbId, text });
}

/** اجرای اکشن‌های دکمه‌های شیشه‌ای. همه‌ی نوشتن‌ها کشِ پروکسی را باطل می‌کنند. */
async function runCallback(env: Env, s: Settings, chatId: number, data: string, cbId: string, origin: string): Promise<void> {
  const token = s.get('tg_bot_token');
  if (!token) return;
  const [act, a, b] = data.split(':');
  const id = Number(a);

  switch (act) {
    // ── ناوبری
    case 'st':
      await cmdStatus(env, s, chatId, token);
      await ack(token, cbId, 'به‌روز شد');
      return;
    case 'p':
      await cmdUsers(env, s, chatId, token, a ?? '1', 1);
      await ack(token, cbId, '');
      return;
    case 'm': {
      const r = await findClient(env, a ?? '');
      if (r) await tgSend(token, chatId, card(r, s, origin), cardKb(r));
      await ack(token, cbId, '');
      return;
    }

    // ── اکشن‌ها
    case 't': {
      const r = await findClient(env, String(id));
      if (!r) return ack(token, cbId, 'پیدا نشد');
      const next = r.enable ? 0 : 1;
      await env.DB.prepare('UPDATE clients SET enable = ? WHERE id = ?').bind(next, id).run();
      invalidateClients();
      await ack(token, cbId, next ? 'روشن شد ▶️' : 'خاموش شد ⏸');
      await tgSend(token, chatId, card({ ...r, enable: next }, s, origin), cardKb({ ...r, enable: next }));
      return;
    }
    case 'r': {
      await env.DB.prepare('UPDATE clients SET up = 0, down = 0, reset_count = reset_count + 1 WHERE id = ?').bind(id).run();
      invalidateClients();
      await ack(token, cbId, 'حجم ریست شد ♻️');
      return;
    }
    case 'w': {
      const days = Math.max(1, Math.floor(Number(b) || 30));
      const now = Math.floor(Date.now() / 1000);
      const add = days * 86400;
      await env.DB.prepare(
        'UPDATE clients SET expiry_at = CASE WHEN expiry_at > ? THEN expiry_at + ? ELSE ? + ? END, enable = 1 WHERE id = ?',
      )
        .bind(now, add, now, add, id)
        .run();
      invalidateClients();
      await ack(token, cbId, `${fmtNum(days)} روز اضافه شد ⏳`);
      return;
    }
    case 'e': {
      await env.DB.prepare('UPDATE clients SET expiry_at = 0 WHERE id = ?').bind(id).run();
      invalidateClients();
      await ack(token, cbId, 'انقضا برداشته شد');
      return;
    }
    case 'd': {
      await tgSend(token, chatId, `⚠️ کاربر <b>#${fmtNum(id)}</b> برای همیشه حذف شود؟`, {
        inline_keyboard: [
          [
            { text: '🚫 نه', callback_data: 'noop' },
            { text: '🗑 بله، حذف کن', callback_data: `dd:${id}` },
          ],
        ],
      });
      await ack(token, cbId, '');
      return;
    }
    case 'dd': {
      await env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
      invalidateClients();
      await ack(token, cbId, 'حذف شد 🗑');
      await tgSend(token, chatId, `🗑 کاربر <b>#${fmtNum(id)}</b> حذف شد.`);
      return;
    }
    case 'k': {
      const on = a === 'on';
      await setSettings(env, { kill_switch: on ? '1' : '0' });
      invalidateClients();
      await ack(token, cbId, on ? 'سرویس قطع شد 🛑' : 'سرویس برگشت ✅');
      await cmdStatus(env, s, chatId, token);
      return;
    }
    default:
      await ack(token, cbId, '');
  }
}
