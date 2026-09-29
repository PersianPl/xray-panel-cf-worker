/**
 * تزریق WARP و قواعد سفارشی به سه خروجی ساب.
 */
import { describe, expect, it } from 'vitest';
import { buildSingbox } from '../src/sub/singbox';
import { buildClash } from '../src/sub/clash';
import { buildXray } from '../src/sub/xray';
import type { ConfigItem } from '../src/sub/build';

const ID = {
  priv: 'a'.repeat(64),
  v4: '172.16.0.2/32',
  v6: '',
  peer: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wSfVOs=',
  endpoint: '162.159.193.10:2408',
  reserved: [1, 2, 3],
  created: 1700000000,
};

function item(): ConfigItem {
  return {
    endpoint: { address: 'worker.example', label: 'x', ports: [443] },
    spec: {
      protocol: 'vless',
      transport: 'ws',
      address: 'worker.example',
      port: 443,
      auth: '11111111-2222-3333-4444-555555555555',
      path: '/ws',
      host: 'worker.example',
      sni: 'worker.example',
      remark: 'TEST-443',
      maxEarlyData: 0,
      opts: {},
    },
  };
}

const WARP = { mode: 'direct' as const, sites: ['openai.com'], identity: ID };

describe('sing-box + WARP/قواعد سفارشی', () => {
  it('outbound وایرگارد + قانون دامنه‌های WARP', () => {
    const cfg = buildSingbox({ items: [item()], opts: {}, flags: { bypassIran: false, blockAds: false, blockPorn: false, blockQuic: false, ipv6: false, fakedns: false, remoteDns: 'https://dns.google/dns-query', localDns: '8.8.8.8', warp: WARP } }) as {
      outbounds: Array<Record<string, unknown>>;
      route: { rules: Array<Record<string, unknown>> };
    };
    const wg = cfg.outbounds.find((o) => o.type === 'wireguard') as Record<string, unknown> | undefined;
    expect(wg).toBeTruthy();
    expect(wg!['server']).toBe('162.159.193.10');
    expect(wg!['server_port']).toBe(2408);
    expect(wg!['reserved']).toEqual([1, 2, 3]);
    const siteRule = cfg.route.rules.find((r) => r.outbound === '🟢 WARP');
    expect(siteRule?.domain_suffix).toEqual(['openai.com']);
  });

  it('قواعد سفارشی: دامنه و ip جدا می‌شوند', () => {
    const cfg = buildSingbox({
      items: [item()],
      opts: {},
      flags: {
        bypassIran: false, blockAds: false, blockPorn: false, blockQuic: false, ipv6: false, fakedns: false,
        remoteDns: 'https://dns.google/dns-query', localDns: '8.8.8.8',
        direct: ['a.com', 'ip:1.2.3.0/24'],
        block: ['b.com'],
        proxy: ['c.com'],
      },
    }) as { route: { rules: Array<Record<string, unknown>> } };
    const direct = cfg.route.rules.find((r) => r.outbound === 'direct' && r.domain_suffix);
    expect(direct?.domain_suffix).toEqual(['a.com']);
    const ipRule = cfg.route.rules.find((r) => r.outbound === 'direct' && r.ip_cidr);
    expect(ipRule?.ip_cidr).toEqual(['1.2.3.0/24']);
    expect(cfg.route.rules.find((r) => r.outbound === 'block' && r.domain_suffix)?.domain_suffix).toEqual(['b.com']);
    expect(cfg.route.rules.find((r) => r.outbound === '✅ انتخاب' && r.domain_suffix)?.domain_suffix).toEqual(['c.com']);
  });
});

describe('clash + WARP', () => {
  it('پروکسی wireguard + گروه + قاعده‌ی دامنه', () => {
    const y = buildClash({
      items: [item()],
      opts: {},
      flags: { bypassIran: false, blockAds: false, blockPorn: false, ipv6: false, warp: WARP },
      subUrl: 'https://x/sub/tok',
      interval: 12,
    });
    expect(y).toContain('type: wireguard');
    expect(y).toContain('private-key: "aaaaaaaa');
    expect(y).toContain('reserved: [1,2,3]');
    expect(y).toContain('🟢 WARP');
    expect(y).toContain('DOMAIN-SUFFIX,openai.com,"🟢 WARP"');
  });

  it('قواعد سفارشی clash با پالیسی درست', () => {
    const y = buildClash({
      items: [item()],
      opts: {},
      flags: { bypassIran: false, blockAds: false, blockPorn: false, ipv6: false, direct: ['a.com'], block: ['ip:9.9.9.9/32'] },
      subUrl: 'https://x/sub/tok',
      interval: 12,
    });
    expect(y).toContain('DOMAIN-SUFFIX,a.com,DIRECT');
    expect(y).toContain('IP-CIDR,9.9.9.9/32,REJECT,no-resolve');
  });
});

describe('xray + WARP', () => {
  it('outbound wireguard + قانون دامنه', () => {
    const cfgs = buildXray({
      items: [item()],
      opts: {},
      flags: {
        bypassIran: false, blockAds: false, blockPorn: false, blockQuic: false, ipv6: false, fakedns: false,
        remoteDns: 'https://dns.google/dns-query', localDns: '8.8.8.8', underlyingDoh: '', warp: WARP,
      },
    }) as Array<{ outbounds: Array<Record<string, unknown>>; routing: { rules: Array<Record<string, unknown>> } }>;
    const wg = cfgs[0]!.outbounds.find((o) => o.protocol === 'wireguard') as {
      settings: { peers: Array<Record<string, unknown>> };
    };
    expect(wg.settings.peers[0]!['endpoint']).toBe('162.159.193.10:2408');
    expect(wg.settings.peers[0]!['reserved']).toEqual([1, 2, 3]);
    const rule = cfgs[0]!.routing.rules.find((r) => r.outboundTag === 'warp');
    expect(rule?.domain).toEqual(['openai.com']);
  });
});
