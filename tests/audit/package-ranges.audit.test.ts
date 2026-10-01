import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// An exact internal pin ("workspace:*" publishes as "0.1.0") makes a fresh
// install carry two copies of @erc8426/core once one package moves ahead, and
// then `instanceof WalletPassError` fails across them. Internal dependencies
// must publish as caret ranges.
const root = join(__dirname, "..", "..");
const packages = readdirSync(join(root, "packages"));

describe("published dependency ranges", () => {
  for (const name of packages) {
    it(`${name} depends on sibling packages by caret range`, () => {
      const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
      const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
      for (const [dep, range] of Object.entries(deps)) {
        if (dep.startsWith("@erc8426/")) expect(range, `${name} -> ${dep}`).toBe("workspace:^");
      }
    });
  }
});
