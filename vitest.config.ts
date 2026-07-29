import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests shell out to git many times per test; on Windows
    // (process spawn + Defender scanning) that routinely exceeds the 5s
    // default. Generous ceilings — the suite is still fast on POSIX.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
