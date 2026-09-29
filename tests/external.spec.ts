/**
 * ساب‌های بیرونی و DoH خود پنل.
 */
import { describe, expect, it, vi } from 'vitest';
import { extractLinks, mergeExternalSubs } from '../src/sub/external';
import { handleDoh } from '../src/sub/doh';

function b64(s: string): string {
  return btoa(s);
}

describe('extractLinks', () => {
  it('لینک خام: خطوط معتبر فیلتر می‌شوند', () => {
    const raw = ['vless://u@h:443?type=ws#A', 'جملات بی‌ربط', 'ss://YWVzOnA=@h:1#B', 'vmess://' + b64('{}')].join('\n');
    const out = extractLinks(raw);
    expect(out.length).toBe(3);
    expect(out[0]).toContain('vless://');
  });
  it('base64 کلاسیک هم باز می‌شود', () => {
    const raw = b64('trojan://pass@h:443?type=ws#T\nvless://u@h:443#V');
    expect(extractLinks(raw)).toHaveLength(2);
  });
  it('ورودی خراب → آرایه‌ی خالی، نه exception', () => {
    expect(extractLinks('!!!')).toEqual([]);
    expect(extractLinks('')).toEqual([]);
  });
  it('سقف ۱۰۰ لینک', () => {
    const raw = Array.from({ length: 300 }, (_, i) => `vless://u@h:${i}#x${i}`).join('\n');
    expect(extractLinks(raw)).toHaveLength(100);
  });
});

describe('mergeExternalSubs', () => {
  it('هر URL جدا fetch و جمع می‌شود؛ خطا ساکت نادیده', async () => {
    const fetchMock = vi.fn(async (u: string) => {
      if (u.includes('good')) return new Response(b64('vless://u@h:1#X'), { status: 200 });
      if (u.includes('bad')) throw new Error('network');
      return new Response('nope', { status: 404 });
    });
    const s = { lines: (k: string) => (k === 'external_subs' ? ['https://good/sub', 'https://bad/sub', 'https://404/sub'] : []) };
    const out = await mergeExternalSubs(s as never, fetchMock as unknown as typeof fetch);
    expect(out).toEqual(['vless://u@h:1#X']);
  });
  it('بدون تنظیم → هیچ fetchی نمی‌زند', async () => {
    const fetchMock = vi.fn();
    const out = await mergeExternalSubs({ lines: () => [] } as never, fetchMock as unknown as typeof fetch);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleDoh', () => {
  const UP = 'https://cloudflare-dns.com/dns-query';

  it('GET با ?dns= → به آپ‌استریم فوروارد', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'application/dns-message' } }));
    const res = await handleDoh(new Request(`https://p/sub/dns-query?dns=${encodeURIComponent('AAEBAA')}`), UP, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/dns-message');
    const called = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(called.startsWith(UP + '?dns=')).toBe(true);
  });
  it('POST با body باینری فوروارد می‌شود', async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => new Response('ok', { status: 200 }));
    const req = new Request('https://p/sub/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: new Uint8Array([9, 9]),
    });
    const res = await handleDoh(req, UP, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const init = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });
  it('POST با content-type اشتباه → ۴۱۵؛ GET بدون dns → ۴۰۰', async () => {
    const fetchMock = vi.fn();
    const bad = await handleDoh(new Request('https://x/dq', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }), UP, fetchMock as unknown as typeof fetch);
    expect(bad.status).toBe(415);
    const noDns = await handleDoh(new Request('https://x/dq'), UP, fetchMock as unknown as typeof fetch);
    expect(noDns.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('خطای آپ‌استریم → ۵۰۲', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('down');
    });
    const res = await handleDoh(new Request('https://x/dq?dns=AA'), UP, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(502);
  });
});
