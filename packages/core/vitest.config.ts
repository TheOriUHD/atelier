import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests that make git repositories write exact text: no CRLF conversion from a machine-wide `core.autocrlf` (Windows).
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' },
  },
});
