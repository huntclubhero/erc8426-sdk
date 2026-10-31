import { describe, expect, it } from "vitest";
import { LEGACY_PROOF_HEADER, LEGACY_SIGNATURE_HEADER, PROOF_HEADER, SIGNATURE_HEADER, encodeBase64Url } from "@erc8426/core";

import { TOKEN_ID, buildHarness, newSigner, signChallenge } from "./helpers.js";

// The spec's refusal table: a presented message that is not a parseable
// challenge, or exceeds the size bound, is invalid_message; a request that is
// otherwise malformed (a mixed header pair, a signature that is not hex) is
// invalid_request. The reference server answers the same way.

const MANIFEST = `/wallet-pass/${TOKEN_ID}`;
const ACTION = `/wallet-pass/${TOKEN_ID}/actions/feed`;
const ROTATE = `/wallet-pass/${TOKEN_ID}/rotate`;

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

const routes: [string, (h: ReturnType<typeof buildHarness>, headers: Record<string, string>) => Promise<Response>][] = [
  ["gated manifest", (h, headers) => h.get(MANIFEST, headers)],
  ["signed action", (h, headers) => h.post(ACTION, undefined, headers)],
  ["rotate", (h, headers) => h.post(ROTATE, undefined, headers)],
];

describe.each(routes)("refusal codes on the %s route", (_name, send) => {
  it("an oversized proof header is invalid_message", async () => {
    const h = buildHarness();
    for (const [proofName, signatureName] of [
      [PROOF_HEADER, SIGNATURE_HEADER],
      [LEGACY_PROOF_HEADER, LEGACY_SIGNATURE_HEADER],
    ] as const) {
      const res = await send(h, { [proofName]: "a".repeat(9000), [signatureName]: "0xab" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("invalid_message");
    }
  });

  it("a proof header that is not base64url is invalid_message", async () => {
    const h = buildHarness();
    const res = await send(h, { [PROOF_HEADER]: "***", [SIGNATURE_HEADER]: "0x00" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_message");
  });

  it("a signature that is not hex stays invalid_request", async () => {
    const h = buildHarness();
    const res = await send(h, { [PROOF_HEADER]: encodeBase64Url("x"), [SIGNATURE_HEADER]: "nothex" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("an oversize signature is invalid_request, hex or not, and the hex check comes first", async () => {
    const h = buildHarness();
    for (const signature of ["z".repeat(9000), `0x${"ab".repeat(4500)}`]) {
      const res = await send(h, { [PROOF_HEADER]: encodeBase64Url("x"), [SIGNATURE_HEADER]: signature });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("invalid_request");
    }
  });

  it("a lone oversize proof header is a missing proof", async () => {
    const h = buildHarness();
    const res = await send(h, { [PROOF_HEADER]: "a".repeat(9000) });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("proof_required");
  });

  it("a mixed header pair stays invalid_request", async () => {
    const h = buildHarness();
    const res = await send(h, { [PROOF_HEADER]: encodeBase64Url("x"), [LEGACY_SIGNATURE_HEADER]: "0x00" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });
});

describe("the pair that is not used changes nothing", () => {
  it("a valid unprefixed pair resolves the manifest beside an oversize X- proof", async () => {
    const h = buildHarness();
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const p = await signChallenge(h, owner);
    const res = await h.get(MANIFEST, {
      [PROOF_HEADER]: encodeBase64Url(p.message),
      [SIGNATURE_HEADER]: p.signature,
      [LEGACY_PROOF_HEADER]: "a".repeat(9000),
      [LEGACY_SIGNATURE_HEADER]: "0xab",
    });
    expect(res.status).toBe(200);
  });
});

describe("refusal codes for a proof in the body", () => {
  it("a body proof with a signature that is not hex stays invalid_request", async () => {
    const h = buildHarness();
    const message = "anything";
    const res = await h.post(ACTION, { message, signature: "nothex" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("a body proof whose message is not a challenge is invalid_message", async () => {
    const h = buildHarness();
    const account = newSigner();
    const message = "not a challenge";
    const res = await h.post(ACTION, { message, signature: await account.signMessage({ message }) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_message");
  });
});
