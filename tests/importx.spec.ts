/**
 * ایمپورت x-ui: نرمال‌سازی inbound/کلاینت‌ها + پرش با هشدار.
 */
import { describe, expect, it } from 'vitest';
import { importXui } from '../src/panel/importx';
import { FakeD1, fakeEnv } from './stubs/d1';
import type { Env } from '../src/types';

function env(db: FakeD1): Env {
  return fakeEnv(db) as unknown as Env;
}

const XUI = {
  inbounds: [
    {
      port: 443,
      protocol: 'vless',
      tag: 'vless-ws',
      settings: JSON.stringify({
        clients: [
          { id: '11111111-2222-3333-4444-555555555555', email: 'ali@example.com', totalGB: 21474836480, expiryTime: 1800000000000, limitIp: 3, tgId: '123' },
          { id: '', email: 'noid@x' },
        ],
      }),
      streamSettings: JSON.stringify({
        network: 'ws',
        security: 'tls',
        wsSettings: { path: '/ws', headers: { Host: 'x.com' } },
        tlsSettings: { serverName: 'sni.com' },
      }),
    },
    {
      port: 8443,
      protocol: 'trojan',
      tag: 'trojan-tcp',
      settings: JSON.stringify({ clients: [{ password: 'trojan-pass', email: 'carol@x' }] }),
      streamSettings: JSON.stringify({ network: 'tcp', security: 'tls' }),
    },
    {
      port: 2053,
      protocol: 'vmess',
      tag: 'vmess-reality',
      settings: JSON.stringify({ clients: [{ id: '99999999-8888-7777-6666-555555555555', email: 'reality@x', flow: 'xtls-rprx-vision' }] }),
      streamSettings: JSON.stringify({ network: 'grpc', security: 'reality' }),
    },
  ],
};

describe('importXui', () => {
  it('ws+vless نرمال می‌شود؛ grpc/reality و tcp پرش می‌شوند', async () => {
    const db = new FakeD1();
    const out = await importXui(env(db), XUI);
    expect(out.ok).toBe(true);
    // فقط vless-ws: trojan/tcp و vmess/grpc+reality پرش شدند.
    expect(out.inbounds).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.warnings.some((w) => w.includes('Reality'))).toBe(true);

    const ib = db.find('INSERT INTO inbounds')[0]!;
    expect(ib.args).toContain('vless');
    expect(ib.args).toContain('ws');
    expect(ib.args).toContain('/ws');
    expect(ib.args).toContain('x.com');
    expect(ib.args).toContain('sni.com');
    expect(ib.args).toContain(JSON.stringify([443]));

    // فقط کلاینت‌های inbound پذیرفته‌شده وارد می‌شوند.
    const ins = db.find('INSERT INTO clients');
    expect(ins.length).toBe(2);
    expect(ins[0]!.args).toContain('11111111-2222-3333-4444-555555555555');
    expect(ins[0]!.args).toContain('ali');
    expect(ins[0]!.args).toContain(20); // 21474836480 → 20GB
    expect(ins[0]!.args).toContain(3); // limitIp
    expect(ins[0]!.args).toContain('123'); // tgId
  });

  it('expiryTime میلی‌ثانیه → ثانیه؛ نبودِ id → uuid خودکار', async () => {
    const db = new FakeD1();
    await importXui(env(db), XUI);
    const ins = db.find('INSERT INTO clients');
    // 1800000000000ms → 1800000000s
    expect(ins[0]!.args).toContain(1800000000);
    expect(ins[1]!.args[2]).toMatch(/^[0-9a-f-]{36}$/); // auth تولید شد
    // توکن ساب تازه و متفاوت
    expect(ins[0]!.args).not.toEqual(ins[1]!.args);
  });

  it('ساختار نامشخص → ok:false با پیام فارسی', async () => {
    const db = new FakeD1();
    const out = await importXui(env(db), { hello: 'world' });
    expect(out.ok).toBe(false);
    expect(out.warnings[0]).toContain('inbounds');
    expect(db.find('INSERT INTO inbounds')).toHaveLength(0);
  });
});

