import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import root from "../../vitest.config.js";

// Audit-only config: the root aliases, but only this directory's tests.
export default defineConfig({
  ...root,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: { ...root.test, include: ["tests/audit/**/*.test.ts"], testTimeout: 60000 },
});
