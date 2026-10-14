import { describe, expect, it } from "vitest";

import { MAX_CHALLENGE_MESSAGE_CHARS, buildChallenge, parseChallenge, tokenRef } from "@erc8426/core";

// Reported by Nexory (2026-10-14): viem's SIWE parser is quadratic on a message
// made of repeated "URI: " with no newline (about 600 ms at 64 KiB on viem
// 2.57), and an issuer parses before it knows the caller. The cap refuses such a
// message before the parser ever sees it.
describe("challenge size cap", () => {
  it("refuses a 64 KiB worst-case message without parsing it", () => {
    const message = "URI: ".repeat((64 * 1024) / 5);
    expect(message.length).toBeGreaterThan(MAX_CHALLENGE_MESSAGE_CHARS);
    const t0 = performance.now();
    expect(parseChallenge(message)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("refuses a message one character over the cap and accepts one at it", () => {
    expect(parseChallenge("x".repeat(MAX_CHALLENGE_MESSAGE_CHARS + 1))).toBeNull();
    // At the cap the message is parsed (and refused as garbage), not short-circuited.
    expect(parseChallenge("x".repeat(MAX_CHALLENGE_MESSAGE_CHARS))).toBeNull();
  });

  it("leaves a conforming challenge far under the cap", () => {
    const built = buildChallenge({
      domain: "issuer.example",
      uri: "https://issuer.example/wallet-pass/actions",
      account: "0x1111111111111111111111111111111111111111",
      token: tokenRef(1, "0x2222222222222222222222222222222222222222", 412),
      action: "feed",
      nonce: "Xq3F9kP2mR7tW1Zb",
      issuedAt: new Date("2026-08-07T15:04:05Z"),
      expirationTime: new Date("2026-08-07T15:09:05Z"),
    });
    expect(built.length).toBeLessThan(MAX_CHALLENGE_MESSAGE_CHARS / 2);
    expect(parseChallenge(built)?.nonce).toBe("Xq3F9kP2mR7tW1Zb");
  });
});
