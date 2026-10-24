import { describe, expect, it } from "vitest";
import { LEGACY_PROOF_HEADER, LEGACY_SIGNATURE_HEADER, PROOF_HEADER, SIGNATURE_HEADER, encodeBase64Url, parseManifest } from "@erc8426/core";

import { TOKEN_ID, buildHarness, newSigner, signChallenge } from "./helpers.js";

const MANIFEST = `/wallet-pass/${TOKEN_ID}`;

describe("proof header names (RFC 6648)", () => {
  it("resolves a gated manifest from the new names alone", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner);
    const res = await h.get(MANIFEST, { [PROOF_HEADER]: encodeBase64Url(p.message), [SIGNATURE_HEADER]: p.signature });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: number }).version).toBe(1);
  });

  it("still resolves a gated manifest from the X- names alone, as a 0.2.x client sends them", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner);
    const res = await h.get(MANIFEST, { [LEGACY_PROOF_HEADER]: encodeBase64Url(p.message), [LEGACY_SIGNATURE_HEADER]: p.signature });
    expect(res.status).toBe(200);
  });

  it("the new name wins when both are present", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    // Good proof under the new names, garbage under the old: resolved.
    const p = await signChallenge(h, owner);
    const good = await h.get(MANIFEST, {
      [PROOF_HEADER]: encodeBase64Url(p.message),
      [SIGNATURE_HEADER]: p.signature,
      [LEGACY_PROOF_HEADER]: "!!!",
      [LEGACY_SIGNATURE_HEADER]: "zz",
    });
    expect(good.status).toBe(200);
    // Garbage under the new names, a good proof under the old: the new name is what is read, so refused.
    const p2 = await signChallenge(h, owner);
    const bad = await h.get(MANIFEST, {
      [PROOF_HEADER]: "!!!",
      [SIGNATURE_HEADER]: "zz",
      [LEGACY_PROOF_HEADER]: encodeBase64Url(p2.message),
      [LEGACY_SIGNATURE_HEADER]: p2.signature,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_request");
    // An oversized value under either name is refused before decoding.
    const big = await h.get(MANIFEST, { [LEGACY_PROOF_HEADER]: "a".repeat(9000), [LEGACY_SIGNATURE_HEADER]: "0xab" });
    expect(big.status).toBe(400);
  });

  it("lists all four names in the CORS preflight", async () => {
    const h = buildHarness({ cors: { origins: "*" } });
    const res = await h.issuer.handler(
      new Request(`https://issuer.example${MANIFEST}`, {
        method: "OPTIONS",
        headers: { Origin: "https://wallet.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "wallet-pass-proof" },
      }),
    );
    const allowed = res.headers.get("access-control-allow-headers")!.toLowerCase();
    for (const name of ["wallet-pass-proof", "wallet-pass-signature", "x-wallet-pass-proof", "x-wallet-pass-signature"]) expect(allowed).toContain(name);
  });
});

describe("manifest version and media type", () => {
  it("serves the public manifest as application/json with version 1", async () => {
    const h = buildHarness({ mode: "public" });
    h.chain.setOwner(TOKEN_ID, newSigner().address);
    const res = await h.get(MANIFEST);
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").split(";")[0]!.trim()).toBe("application/json");
    const body = (await res.json()) as { version: number; formats: Record<string, string> };
    expect(body.version).toBe(1);
    expect(Number.isInteger(body.version)).toBe(true);
    const parsed = parseManifest(body);
    expect(parsed.ok && parsed.manifest.version).toBe(1);
    expect(parsed.issues).toEqual([]);
  });

  it("serves the gated manifest as application/json with version 1", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner);
    const res = await h.get(MANIFEST, { [PROOF_HEADER]: encodeBase64Url(p.message), [SIGNATURE_HEADER]: p.signature });
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").split(";")[0]!.trim()).toBe("application/json");
    expect(((await res.json()) as { version: number }).version).toBe(1);
  });
});
