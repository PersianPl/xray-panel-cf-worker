/**
 * ادغام ساب‌های بیرونی — همان کاری که BPB می‌کند.
 *
 * هر URL یک ساب کامل (base64 یا لینک خام) است؛ محتوایش خوانده و خطوط لینکِ
 * معتبرش به انتهای فهرست ساب خودِ پنل اضافه می‌شود. best-effort است: خطای
 * هر URL کل ساب را نمی‌شکند — فقط نادیده گرفته می‌شود.
 *
 * چرا فقط v2ray/html: خروجی sing-box/Clash/Xray ساختارمند است و لینک خام
 * نمی‌گیرد؛ برای آن فرمت‌ها ادغام بی‌معنی است.
 */
const MAX_SUBS = 5;
const MAX_LINKS = 100;

const LINK_RE = /^(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|socks|socks5):\/\//i;

/** خطوط لینک معتبر از متن خام یا بیس‌۶۴. */
export function extractLinks(raw: string): string[] {
  let text = raw.trim();
  if (!text) return [];
  // اگر لینک خام نبود، احتمالاً base64 است (حتی با خط‌شکنی ناقص).
  if (!LINK_RE.test(text)) {
    try {
      const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
      const bin = atob(cleaned);
      text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    const t = line.trim();
    if (t && LINK_RE.test(t)) out.push(t);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** همه‌ی ساب‌های بیرونی را می‌کشد و لینک‌ها را جمع می‌کند. */
export async function mergeExternalSubs(s: {
  lines: (k: string) => string[];
}, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const urls = s.lines('external_subs').slice(0, MAX_SUBS);
  if (!urls.length) return [];
  const out: string[] = [];
  await Promise.allSettled(
    urls.map(async (u) => {
      const res = await fetchImpl(u, { headers: { 'user-agent': 'PersianPl-Panel' }, cf: { cacheTtl: 300 } });
      if (!res.ok) return;
      const links = extractLinks(await res.text());
      for (const l of links) {
        if (out.length >= MAX_LINKS) return;
        out.push(l);
      }
    }),
  );
  return out;
}
