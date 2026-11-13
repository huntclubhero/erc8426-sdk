import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/// The public testnet run. Not part of `pnpm test`: it sends real
///  transactions and needs funded keys. See tests/testnet/README.md.

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@erc8426\/issuer\/(.*)$/, replacement: fileURLToPath(new URL("./packages/issuer/src/$1", import.meta.url)) },
      ...["core", "client", "issuer", "apple", "google", "react", "conformance"].map((n) => ({ find: `@erc8426/${n}`, replacement: pkg(n) })),
    ],
  },
  test: {
    include: ["tests/testnet/**/*.testnet.test.ts"],
    testTimeout: 180000,
    hookTimeout: 300000,
    fileParallelism: false,
  },
});
