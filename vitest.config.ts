// SPDX-License-Identifier: EUPL-1.2
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ⚠ The live-call fence. Every test file gets it — see test/setup.ts for why this is a runtime
    // guard rather than the CI grep it replaced.
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
