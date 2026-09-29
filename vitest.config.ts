import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // در محیط تست، ماژول داخلی Workers با یک سوکت جعلیِ کنترل‌پذیر جا می‌شود.
      'cloudflare:sockets': fileURLToPath(new URL('./tests/stubs/sockets.ts', import.meta.url)),
    },
  },
  // فقط تست‌های خود پروژه — پوشه‌های _audit/ و .research/ کد تحقیقاتی بیرونی
  // دارند و نباید توسط vitest جمع شوند.
  test: {
    include: ['tests/**/*.spec.ts'],
  },
});
