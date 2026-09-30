import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";

import {
  WALLET_PASS_INTERFACE_ID,
  actionUrn,
  assetId,
  buildChallenge,
  createManifest,
  decodeBase64Url,
  encodeBase64Url,
  normalizeTokenId,
  parseActionUrn,
  parseAssetId,
  parseChallenge,
  parseManifest,
  proofHeaders,
  readMetadataMirror,
  readProofHeaders,
  statusForError,
  tokenRef,
} from "@erc8426/core";

// The literals of the spec's worked example (Example challenge).
const EXAMPLE_CONTRACT = "0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1";
const EXAMPLE_ACCOUNT = "0x2B7E9A4c1F0d8e63A5b2C4D6E8F0A1b3C5d7E9F2";
const SPEC_EXAMPLE = `issuer.example wants you to sign in with your Ethereum account:
0x2B7E9A4c1F0d8e63A5b2C4D6E8F0A1b3C5d7E9F2

Authorize the feed action for wallet pass token 412 on issuer.example.

URI: https://issuer.example/wallet-pass/actions
Version: 1
Chain ID: 1
Nonce: Xq3F9kP2mR7tW1Zb
Issued At: 2026-08-07T15:04:05Z
Expiration Time: 2026-08-07T15:09:05Z
Resources:
- eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/412
- urn:wallet-pass:action:feed`;

describe("interface id", () => {
  it("is the selector of passURI(uint256), the only function in the interface", () => {
    expect(toFunctionSelector("passURI(uint256)")).toBe(WALLET_PASS_INTERFACE_ID);
  });
});

describe("caip", () => {
  it("builds the spec's asset id and parses it back", () => {
    const id = assetId(1, EXAMPLE_CONTRACT.toLowerCase(), 412n);
    expect(id).toBe("eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/412");
    expect(parseAssetId(id)).toEqual(tokenRef(1, EXAMPLE_CONTRACT, "412"));
    expect(parseAssetId("eip155:1/erc1155:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/412")).toBeNull();
  });
  it("canonicalizes token ids so one token has one asset id", () => {
    expect(normalizeTokenId("007")).toBe("7");
    expect(normalizeTokenId(2n ** 200n)).toBe((2n ** 200n).toString());
    expect(() => normalizeTokenId("-1")).toThrow();
    expect(() => normalizeTokenId(2 ** 60)).toThrow();
  });
  it("round-trips action URNs and rejects junk", () => {
    expect(actionUrn("feed")).toBe("urn:wallet-pass:action:feed");
    expect(parseActionUrn("urn:wallet-pass:action:feed")).toBe("feed");
    expect(parseActionUrn("urn:other:feed")).toBeNull();
    expect(() => actionUrn("has space")).toThrow();
  });
});

describe("challenge", () => {
  it("reproduces the spec's worked example field for field", () => {
    const built = buildChallenge({
      domain: "issuer.example",
      uri: "https://issuer.example/wallet-pass/actions",
      account: EXAMPLE_ACCOUNT,
      token: tokenRef(1, EXAMPLE_CONTRACT, 412),
      action: "feed",
      nonce: "Xq3F9kP2mR7tW1Zb",
      issuedAt: new Date("2026-08-07T15:04:05Z"),
      expirationTime: new Date("2026-08-07T15:09:05Z"),
    });
    // viem emits fractional seconds; the spec says both forms conform.
    expect(built.replace(/\.000Z/g, "Z")).toBe(SPEC_EXAMPLE);
  });
  it("parses the spec example into the floor fields", () => {
    const parsed = parseChallenge(SPEC_EXAMPLE)!;
    expect(parsed.domain).toBe("issuer.example");
    expect(parsed.address).toBe(EXAMPLE_ACCOUNT);
    expect(parsed.chainId).toBe(1);
    expect(parsed.nonce).toBe("Xq3F9kP2mR7tW1Zb");
    expect(parsed.expirationTime?.toISOString()).toBe("2026-08-07T15:09:05.000Z");
    expect(parsed.token).toEqual(tokenRef(1, EXAMPLE_CONTRACT, 412));
    expect(parsed.action).toBe("feed");
  });
  it("treats two token resources as ambiguous", () => {
    const doubled = SPEC_EXAMPLE + "\n- eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/413";
    expect(parseChallenge(doubled)!.token).toBeNull();
  });
  it("returns null for text that is not a challenge", () => {
    expect(parseChallenge("hello")).toBeNull();
  });
});

describe("manifest", () => {
  const good = {
    formats: {
      apple: "https://issuer.example/passes/c3f1/card.pkpass",
      google: "https://pay.google.com/gp/v/save/eyJhbGciOi",
      samsung: "https://example.com/other",
    },
    updatedAt: 1754500000,
  };
  it("accepts the spec example and keeps unknown keys", () => {
    const r = parseManifest(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.formats.samsung).toBe("https://example.com/other");
  });
  it("requires at least one format", () => {
    expect(parseManifest({ formats: {} }).ok).toBe(false);
    expect(parseManifest({}).ok).toBe(false);
  });
  it("requires the google format to be a Save to Google Wallet link", () => {
    expect(parseManifest({ formats: { google: "https://evil.example/save" } }).ok).toBe(false);
  });
  it("refuses acquisition URLs a client could not safely navigate to", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://evil.example/p.pkpass"]) {
      expect(parseManifest({ formats: { apple: url } }).ok).toBe(false);
    }
    expect(parseManifest({ formats: { apple: "http://localhost:3000/p.pkpass" } }).ok).toBe(true);
  });
  it("requires integer seconds and flags milliseconds", () => {
    expect(parseManifest({ ...good, updatedAt: 1.5 }).ok).toBe(false);
    const ms = parseManifest({ ...good, updatedAt: 1754500000000 * 1000 });
    expect(ms.ok && ms.issues.some((i) => i.level === "warning")).toBe(true);
  });
  it("creates manifests and reads the metadata mirror", () => {
    const m = createManifest({ apple: "https://a.example/p.pkpass", google: "" }, new Date(1754500000000));
    expect(m).toEqual({ formats: { apple: "https://a.example/p.pkpass" }, updatedAt: 1754500000 });
    expect(readMetadataMirror({ name: "x" })).toBeNull();
    expect(readMetadataMirror({ wallet_pass: good })?.ok).toBe(true);
  });
});

describe("proof headers", () => {
  it("round-trips a multi-line message and signature", () => {
    const headers = new Headers(proofHeaders({ message: SPEC_EXAMPLE, signature: "0xabcd" }));
    const read = readProofHeaders(headers);
    expect(read).toEqual({ kind: "present", proof: { message: SPEC_EXAMPLE, signature: "0xabcd" } });
    expect(readProofHeaders({})).toEqual({ kind: "absent" });
    expect(readProofHeaders({ "x-wallet-pass-signature": "0xab" }).kind).toBe("malformed");
    expect(readProofHeaders({ "x-wallet-pass-proof": "e30", "x-wallet-pass-signature": "zz" })).toEqual({ kind: "malformed", reason: "signature" });
  });
  it("encodes base64url without padding and survives unicode", () => {
    const s = "café \u{1F43E}";
    const enc = encodeBase64Url(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(enc)).toBe(s);
  });
});

describe("statuses", () => {
  it("reserves 403 for the entitlement refusal alone", () => {
    const codes = ["invalid_message", "domain_mismatch", "nonce_invalid", "challenge_expired", "not_yet_valid", "binding_mismatch", "signature_invalid", "not_owner", "read_failed", "proof_required", "malformed_proof", "invalid_address", "invalid_token", "unknown_action", "link_invalid", "not_found"] as const;
    expect(codes.filter((c) => statusForError(c) === 403)).toEqual(["not_owner"]);
    expect(statusForError("read_failed")).toBe(503);
  });
});
