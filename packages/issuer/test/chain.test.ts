import { describe, expect, it } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, encodeErrorResult, zeroAddress, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { tokenRef } from "@erc8426/core";
import { publicClientChainReader } from "@erc8426/issuer";

import { CONTRACT, newSigner } from "./helpers.js";

const token = tokenRef(1, CONTRACT, "412");

const nonexistent = encodeErrorResult({
  abi: [{ type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] }],
  errorName: "ERC721NonexistentToken",
  args: [412n],
});

/// A real viem PublicClient over a scripted transport, so the reader is
///  exercised against viem's own error classes rather than hand-built ones.
function client(answer: (params: unknown[]) => Hex | { revert: Hex } | Error, seen: unknown[][] = []) {
  return createPublicClient({
    chain: mainnet,
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        seen.push(params);
        const a = answer(params);
        if (a instanceof Error) throw a;
        if (typeof a === "object") throw Object.assign(new Error("execution reverted"), { code: 3, data: a.revert });
        return a;
      },
    }, { retryCount: 0 }),
  });
}

const addr = (a: string) => encodeAbiParameters([{ type: "address" }], [a as Hex]);

describe("publicClientChainReader", () => {
  it("returns the owner from a fresh eth_call", async () => {
    const owner = newSigner().address;
    const seen: unknown[][] = [];
    const reader = publicClientChainReader(client(() => addr(owner), seen));
    expect(await reader.ownerOf(token)).toBe(owner);
    expect(await reader.ownerOf(token)).toBe(owner);
    expect(seen).toHaveLength(2);
  });

  it("reads a nonexistent token (ERC721NonexistentToken revert) as no owner", async () => {
    const reader = publicClientChainReader(client(() => ({ revert: nonexistent })));
    expect(await reader.ownerOf(token)).toBeNull();
  });

  it("reads a zero address owner as no owner", async () => {
    const reader = publicClientChainReader(client(() => addr(zeroAddress)));
    expect(await reader.ownerOf(token)).toBeNull();
  });

  it("throws when the read could not be taken, so the issuer answers 503 and not 403", async () => {
    const reader = publicClientChainReader(client(() => new Error("fetch failed")));
    await expect(reader.ownerOf(token)).rejects.toThrow();
  });

  it("reads at the configured block tag", async () => {
    const seen: unknown[][] = [];
    const reader = publicClientChainReader(client(() => addr(newSigner().address), seen), { blockTag: "safe" });
    await reader.ownerOf(token);
    expect(seen[0]![1]).toBe("safe");
  });

  it("reads ERC-4907 userOf and userExpires", async () => {
    const user = newSigner().address;
    const reader = publicClientChainReader(
      client((params) => {
        const data = (params[0] as { data: Hex }).data;
        // userOf(uint256) is 0xc2f1f14a; userExpires(uint256) is 0x8fc88c48.
        return data.startsWith("0xc2f1f14a") ? addr(user) : encodeAbiParameters([{ type: "uint256" }], [1234n]);
      }),
    );
    expect(await reader.userOf!(token)).toEqual({ user, expires: 1234n });
  });

  it("calls checkDelegateForERC721 on the registry", async () => {
    const seen: unknown[][] = [];
    const reader = publicClientChainReader(client(() => encodeAbiParameters([{ type: "bool" }], [true]), seen));
    const ok = await reader.checkDelegateForERC721!({
      registry: "0x00000000000000447e69651d841bD8D104Bed493",
      to: newSigner().address,
      from: newSigner().address,
      token,
      rights: `0x${"0".repeat(64)}`,
    });
    expect(ok).toBe(true);
    expect((seen[0]![0] as { to: string }).to.toLowerCase()).toBe("0x00000000000000447e69651d841bd8d104bed493");
  });
});
