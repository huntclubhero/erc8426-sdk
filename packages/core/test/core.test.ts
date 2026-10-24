import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";

import {
  CANONICAL_WALLET_PASS_ERROR_CODES,
  LEGACY_PROOF_HEADER,
  LEGACY_SIGNATURE_HEADER,
  MANIFEST_VERSION,
  MAX_TOKEN_ID,
  PROOF_HEADER,
  PROOF_HEADER_NAMES,
  SIGNATURE_HEADER,
  WALLET_PASS_ERROR_CODES,
  WALLET_PASS_INTERFACE_ID,
  actionUrn,
  assetId,
  buildChallenge,
  canonicalErrorCode,
  createManifest,
  decodeBase64Url,
  encodeBase64Url,
  isDeprecatedWalletPassErrorCode,
  isWalletPassErrorCode,
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
  type WalletPassErrorCode,
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
  it("accepts every uint256 and nothing past it", () => {
    const max = 2n ** 256n - 1n;
    expect(MAX_TOKEN_ID).toBe(max);
    expect(normalizeTokenId(max)).toBe(max.toString());
    expect(normalizeTokenId(max.toString())).toBe(max.toString());
    expect(normalizeTokenId(`000${max.toString()}`)).toBe(max.toString());
    expect(normalizeTokenId(0)).toBe("0");
    expect(normalizeTokenId("0")).toBe("0");
    expect(() => normalizeTokenId(2n ** 256n)).toThrow(/exceeds uint256/);
    expect(() => normalizeTokenId((2n ** 256n).toString())).toThrow(/exceeds uint256/);
    expect(() => normalizeTokenId("1".repeat(79))).toThrow(/exceeds uint256/);
    expect(() => normalizeTokenId("9".repeat(400))).toThrow(/exceeds uint256/);
    expect(() => tokenRef(1, EXAMPLE_CONTRACT, 2n ** 256n)).toThrow(/exceeds uint256/);
    expect(parseAssetId(`eip155:1/erc721:${EXAMPLE_CONTRACT}/${(2n ** 256n).toString()}`)).toBeNull();
  });
  it("refuses negative and non-integer ids in every input type", () => {
    expect(() => normalizeTokenId(-1)).toThrow(/invalid token id/);
    expect(() => normalizeTokenId(-1n)).toThrow(/invalid token id/);
    expect(() => normalizeTokenId(1.5)).toThrow(/invalid token id/);
    expect(() => normalizeTokenId("1.5")).toThrow(/invalid token id/);
    expect(() => normalizeTokenId("1e3")).toThrow(/invalid token id/);
    expect(() => normalizeTokenId("0x10")).toThrow(/invalid token id/);
    expect(() => normalizeTokenId("")).toThrow(/invalid token id/);
    expect(() => normalizeTokenId(Number.NaN)).toThrow(/invalid token id/);
    expect(() => normalizeTokenId(Number.POSITIVE_INFINITY)).toThrow(/invalid token id/);
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
  it("reads the token and the action by position: first resource, second resource", () => {
    // Swapped: the action URN sits where the token belongs and vice versa,
    // so neither is read. A verifier refuses this as binding_mismatch.
    const swapped = SPEC_EXAMPLE.replace(
      "- eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/412\n- urn:wallet-pass:action:feed",
      "- urn:wallet-pass:action:feed\n- eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/412",
    );
    expect(swapped).not.toBe(SPEC_EXAMPLE);
    const parsed = parseChallenge(swapped)!;
    expect(parsed.token).toBeNull();
    expect(parsed.action).toBeNull();
    expect(parsed.resources).toHaveLength(2);
  });
  it("binds whatever sits in the action's place, not an action listed elsewhere", () => {
    // A second token in the action's place: the token still comes from the
    // first resource, and the action is null even though a URN follows.
    const shifted = SPEC_EXAMPLE.replace(
      "- urn:wallet-pass:action:feed",
      "- eip155:1/erc721:0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1/413\n- urn:wallet-pass:action:feed",
    );
    const parsed = parseChallenge(shifted)!;
    expect(parsed.token).toEqual(tokenRef(1, EXAMPLE_CONTRACT, 412));
    expect(parsed.action).toBeNull();
  });
  it("tolerates resources after the second, as the reference verifier does", () => {
    const extra = SPEC_EXAMPLE + "\n- https://issuer.example/terms";
    const parsed = parseChallenge(extra)!;
    expect(parsed.token).toEqual(tokenRef(1, EXAMPLE_CONTRACT, 412));
    expect(parsed.action).toBe("feed");
    expect(parsed.resources).toHaveLength(3);
  });
  it("carries no token or action when the message has fewer than two resources", () => {
    const none = SPEC_EXAMPLE.replace(/\nResources:[\s\S]*$/, "");
    expect(parseChallenge(none)!.token).toBeNull();
    const one = SPEC_EXAMPLE.replace("\n- urn:wallet-pass:action:feed", "");
    const parsed = parseChallenge(one)!;
    expect(parsed.token).toEqual(tokenRef(1, EXAMPLE_CONTRACT, 412));
    expect(parsed.action).toBeNull();
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
  it("keeps a google URL that is not a Save to Google Wallet link, with a warning", () => {
    const r = parseManifest({ formats: { google: "https://issuer.example/passes/google/7" } });
    expect(r).toMatchObject({ ok: true, manifest: { formats: { google: "https://issuer.example/passes/google/7" } } });
    expect(r.issues).toEqual([expect.objectContaining({ level: "warning", path: "formats.google" })]);
    const save = parseManifest({ formats: { google: "https://pay.google.com/gp/v/save/abc" } });
    expect(save.issues).toEqual([]);
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
  it("carries an optional integer version, tolerating its absence", () => {
    expect(parseManifest(good)).toMatchObject({ ok: true, manifest: { formats: good.formats } });
    expect((parseManifest(good) as { manifest: { version?: number } }).manifest.version).toBeUndefined();
    const v1 = parseManifest({ ...good, version: 1 });
    expect(v1.ok && v1.manifest.version).toBe(1);
    expect(v1.issues).toEqual([]);
    for (const bad of ["1", 0, -1, 1.5, null, {}]) expect(parseManifest({ ...good, version: bad }).ok, String(bad)).toBe(false);
    const newer = parseManifest({ ...good, version: 2 });
    expect(newer.ok).toBe(true);
    expect(newer.issues.some((i) => i.level === "warning" && i.path === "version")).toBe(true);
    expect(MANIFEST_VERSION).toBe(1);
  });
  it("creates manifests and reads the metadata mirror", () => {
    const m = createManifest({ apple: "https://a.example/p.pkpass", google: "" }, new Date(1754500000000));
    expect(m).toEqual({ version: 1, formats: { apple: "https://a.example/p.pkpass" }, updatedAt: 1754500000 });
    expect(parseManifest(m)).toMatchObject({ ok: true, issues: [] });
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
    // A lone header is short of a complete pair: a missing proof, as the spec says.
    expect(readProofHeaders({ "wallet-pass-signature": "0xab" })).toEqual({ kind: "absent" });
    expect(readProofHeaders({ "x-wallet-pass-signature": "0xab" })).toEqual({ kind: "absent" });
    expect(readProofHeaders({ "wallet-pass-proof": "e30", "wallet-pass-signature": "" })).toEqual({ kind: "absent" });
    expect(readProofHeaders({ "wallet-pass-proof": "e30", "wallet-pass-signature": "zz" })).toEqual({ kind: "malformed", reason: "signature" });
  });
  it("names the proof headers per RFC 6648 and, for this release, sends the X- names beside them", () => {
    expect(PROOF_HEADER).toBe("Wallet-Pass-Proof");
    expect(SIGNATURE_HEADER).toBe("Wallet-Pass-Signature");
    expect(LEGACY_PROOF_HEADER).toBe("X-Wallet-Pass-Proof");
    expect(LEGACY_SIGNATURE_HEADER).toBe("X-Wallet-Pass-Signature");
    const sent = proofHeaders({ message: "m", signature: "0xabcd" });
    expect(sent).toEqual({
      "Wallet-Pass-Proof": encodeBase64Url("m"),
      "Wallet-Pass-Signature": "0xabcd",
      "X-Wallet-Pass-Proof": encodeBase64Url("m"),
      "X-Wallet-Pass-Signature": "0xabcd",
    });
    expect(Object.keys(proofHeaders({ message: "m", signature: "0xabcd" }, { legacy: false }))).toEqual(["Wallet-Pass-Proof", "Wallet-Pass-Signature"]);
    expect([...PROOF_HEADER_NAMES]).toEqual(["Wallet-Pass-Proof", "Wallet-Pass-Signature", "X-Wallet-Pass-Proof", "X-Wallet-Pass-Signature"]);
  });
  it("reads a proof under either name set, and the new name wins when both are present", () => {
    const enc = encodeBase64Url("new");
    const old = encodeBase64Url("old");
    expect(readProofHeaders({ "Wallet-Pass-Proof": enc, "Wallet-Pass-Signature": "0x01" })).toEqual({ kind: "present", proof: { message: "new", signature: "0x01" } });
    expect(readProofHeaders({ "X-Wallet-Pass-Proof": old, "X-Wallet-Pass-Signature": "0x02" })).toEqual({ kind: "present", proof: { message: "old", signature: "0x02" } });
    expect(
      readProofHeaders(new Headers({ "Wallet-Pass-Proof": enc, "Wallet-Pass-Signature": "0x01", "X-Wallet-Pass-Proof": old, "X-Wallet-Pass-Signature": "0x02" })),
    ).toEqual({ kind: "present", proof: { message: "new", signature: "0x01" } });
    // Each name form is a pair: a stray unprefixed header beside a complete X- pair
    // does not make an unprefixed pair, so the X- pair is used.
    expect(readProofHeaders({ "Wallet-Pass-Proof": "!!", "X-Wallet-Pass-Proof": old, "X-Wallet-Pass-Signature": "0x02" })).toEqual({ kind: "present", proof: { message: "old", signature: "0x02" } });
    // A complete unprefixed pair wins even when the X- pair is garbage.
    expect(readProofHeaders({ "Wallet-Pass-Proof": enc, "Wallet-Pass-Signature": "0x01", "X-Wallet-Pass-Proof": "!!", "X-Wallet-Pass-Signature": "zz" })).toEqual({ kind: "present", proof: { message: "new", signature: "0x01" } });
    // Garbage inside the pair that is used is still malformed.
    expect(readProofHeaders({ "Wallet-Pass-Proof": "!!", "Wallet-Pass-Signature": "0x01", "X-Wallet-Pass-Proof": old, "X-Wallet-Pass-Signature": "0x02" })).toEqual({ kind: "malformed", reason: "encoding" });
  });
  it("refuses a mixed pair instead of stitching it together", () => {
    const enc = encodeBase64Url("new");
    expect(readProofHeaders({ "Wallet-Pass-Proof": enc, "X-Wallet-Pass-Signature": "0x02" })).toEqual({ kind: "malformed", reason: "mixed" });
    expect(readProofHeaders(new Headers({ "X-Wallet-Pass-Proof": enc, "Wallet-Pass-Signature": "0x02" }))).toEqual({ kind: "malformed", reason: "mixed" });
    expect(readProofHeaders({ "Wallet-Pass-Proof": enc, "X-Wallet-Pass-Proof": enc })).toEqual({ kind: "malformed", reason: "mixed" });
  });
  it("encodes base64url without padding and survives unicode", () => {
    const s = "café \u{1F43E}";
    const enc = encodeBase64Url(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(enc)).toBe(s);
  });
  it("decodes correctly padded base64url identically, and refuses misplaced padding", () => {
    for (const s of ["a", "ab", "abc", "abcd", "café \u{1F43E}", SPEC_EXAMPLE]) {
      const enc = encodeBase64Url(s);
      const padded = enc + "=".repeat((4 - (enc.length % 4)) % 4);
      expect(decodeBase64Url(padded)).toBe(s);
      expect(readProofHeaders({ "Wallet-Pass-Proof": padded, "Wallet-Pass-Signature": "0x01" })).toEqual({ kind: "present", proof: { message: s, signature: "0x01" } });
    }
    expect(decodeBase64Url("YQ==")).toBe("a");
    expect(decodeBase64Url("YWI=")).toBe("ab");
    for (const bad of ["YQ=", "YQ===", "Y=Q=", "=YQ", "YWJj=", "YWI==", "YQ==YQ==", "Y+8=", "Y/8="]) {
      expect(() => decodeBase64Url(bad), bad).toThrow();
    }
  });
});

describe("statuses", () => {
  it("reserves 403 for the entitlement refusal alone", () => {
    expect(WALLET_PASS_ERROR_CODES.filter((c) => statusForError(c) === 403)).toEqual(["not_owner"]);
    expect(statusForError("read_failed")).toBe(503);
  });

  it("maps every code to the status of the spec's refusal table", () => {
    const table: Record<string, number> = {
      invalid_request: 400,
      invalid_message: 400,
      domain_mismatch: 400,
      binding_mismatch: 400,
      proof_required: 401,
      nonce_invalid: 401,
      challenge_expired: 401,
      signature_invalid: 401,
      not_owner: 403,
      unknown_capability: 404,
      insufficient_balance: 409,
      rate_limited: 429,
      read_failed: 503,
    };
    for (const [code, status] of Object.entries(table)) expect(statusForError(code as WalletPassErrorCode), code).toBe(status);
    // Pending addition to the table (PR #2036): a Not Before in the future is a failed freshness check.
    expect(statusForError("not_yet_valid")).toBe(401);
    for (const code of Object.keys(table)) expect(CANONICAL_WALLET_PASS_ERROR_CODES).toContain(code);
  });

  it("accepts the 0.2.x names as deprecated aliases of the spec's codes", () => {
    const aliases: Record<string, [string, number]> = {
      malformed_proof: ["invalid_request", 400],
      invalid_address: ["invalid_request", 400],
      invalid_token: ["invalid_request", 400],
      link_invalid: ["unknown_capability", 404],
      not_found: ["unknown_capability", 404],
    };
    for (const [old, [canonical, status]] of Object.entries(aliases)) {
      expect(isWalletPassErrorCode(old)).toBe(true);
      expect(isDeprecatedWalletPassErrorCode(old)).toBe(true);
      expect(canonicalErrorCode(old as WalletPassErrorCode)).toBe(canonical);
      expect(statusForError(old as WalletPassErrorCode)).toBe(status);
      // The SDK never emits them.
      expect(CANONICAL_WALLET_PASS_ERROR_CODES).not.toContain(old);
    }
    expect(isDeprecatedWalletPassErrorCode("not_owner")).toBe(false);
    expect(canonicalErrorCode("not_owner")).toBe("not_owner");
    expect(isWalletPassErrorCode("made_up")).toBe(false);
  });
});
