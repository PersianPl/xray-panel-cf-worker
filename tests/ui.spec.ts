import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { page } from '../src/panel/ui';
import { DEFAULTS, Settings } from '../src/lib/settings';

function render(view: 'login' | 'app') {
  return page({ view, s: new Settings(new Map(Object.entries(DEFAULTS))) });
}

describe('panel browser scripts', () => {
  for (const view of ['login', 'app'] as const) {
    it(`${view}: emitted JavaScript parses, not just its TypeScript template`, () => {
      const html = render(view);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      expect(scripts).toHaveLength(1);
      for (const script of scripts) new Script(script[1]!, { filename: `${view}.browser.js` });
    });
  }
});
