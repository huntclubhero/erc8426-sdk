import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@erc8426\/issuer\/(.*)$/, replacement: fileURLToPath(new URL("./packages/issuer/src/$1", import.meta.url)) },
      ...["core", "client", "issuer", "apple", "google", "react", "conformance"].map((n) => ({ find: `@erc8426/${n}`, replacement: pkg(n) })),
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx", "tests/e2e/**/*.test.ts"],
    testTimeout: 30000,
  },
});
