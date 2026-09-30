// Runs in the node environment on purpose: no window, no document, no
// navigator. Rendering must not touch any of them.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createPublicClient, custom, getAddress } from "viem";
import { AddToWalletButton, WalletPassProvider } from "@erc8426/react";

describe("server rendering", () => {
  it("renders the button without browser globals or network calls", () => {
    expect(typeof window).toBe("undefined");
    let calls = 0;
    const publicClient = createPublicClient({ transport: custom({ request: async () => (calls++, null) }) });
    const fetch = (async () => {
      calls++;
      throw new Error("no fetch during render");
    }) as unknown as typeof globalThis.fetch;
    const html = renderToString(
      <WalletPassProvider options={{ publicClient, fetch }}>
        <AddToWalletButton contract={getAddress("0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1")} tokenId={1} />
      </WalletPassProvider>,
    );
    expect(html).toContain("Add to Wallet");
    expect(html).toContain("0x5F9B...c2e1");
    expect(calls).toBe(0);
  });
});
