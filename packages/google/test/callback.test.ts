import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import {
  CALLBACK_PROTOCOL_VERSION,
  GOOGLE_PAY_PASSES_SENDER_ID,
  GOOGLE_ROOT_KEYS_URL,
  MAX_CALLBACK_BODY_BYTES,
  callbackHandler,
  createCallbackVerifier,
  maxAgeOf,
  memoryCallbackNonceStore,
  toSignedString,
  type CallbackEvent,
  type GoogleRootKeys,
} from "@erc8426/google";
import { describe, expect, it } from "vitest";

const ISSUER = "3388000000012345678";
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const HOUR = 3_600_000;

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, keyValue: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

function ecdsa(key: KeyObject, data: Uint8Array): string {
  return sign("sha256", data, { key, dsaEncoding: "der" }).toString("base64");
}

/// A Google-side signing setup: a root key, an intermediate key signed by it,
///  and a function that signs messages the way the callback does.
function googleSide(o: { intermediateExpiresAt?: number } = {}) {
  const root = p256();
  const intermediate = p256();
  const signedKey = JSON.stringify({ keyValue: intermediate.keyValue, keyExpiration: String(o.intermediateExpiresAt ?? NOW + 24 * HOUR) });
  const intermediateSignature = ecdsa(root.privateKey, toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, CALLBACK_PROTOCOL_VERSION, signedKey));
  const rootKeys: GoogleRootKeys = {
    keys: [
      { keyValue: root.keyValue, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: String(NOW + 365 * 24 * HOUR) },
      // An expired root and one for another protocol: both ignored.
      { keyValue: p256().keyValue, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: String(NOW - 1) },
      { keyValue: p256().keyValue, protocolVersion: "ECv2", keyExpiration: String(NOW + 365 * 24 * HOUR) },
    ],
  };
  function message(fields: Record<string, unknown> = {}, o2: { recipient?: string; signer?: KeyObject; protocol?: string } = {}) {
    const signedMessage = JSON.stringify({
      classId: `${ISSUER}.collection_v1`,
      objectId: `${ISSUER}.s3r1al.0123456789abcdef`,
      eventType: "save",
      expTimeMillis: String(NOW + HOUR),
      nonce: "nonce-1",
      ...fields,
    });
    const signature = ecdsa(
      o2.signer ?? intermediate.privateKey,
      toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, o2.recipient ?? ISSUER, o2.protocol ?? CALLBACK_PROTOCOL_VERSION, signedMessage),
    );
    return {
      protocolVersion: o2.protocol ?? CALLBACK_PROTOCOL_VERSION,
      signature,
      intermediateSigningKey: { signedKey, signatures: [intermediateSignature] },
      signedMessage,
    };
  }
  return { root, intermediate, signedKey, intermediateSignature, rootKeys, message };
}

function verifier(g: ReturnType<typeof googleSide>, extra: Partial<Parameters<typeof createCallbackVerifier>[0]> = {}) {
  let fetches = 0;
  const v = createCallbackVerifier({
    issuerId: ISSUER,
    now: () => NOW,
    fetchKeys: async () => {
      fetches += 1;
      return g.rootKeys;
    },
    onWarning: () => undefined,
    ...extra,
  });
  return { v, fetches: () => fetches };
}

describe("toSignedString", () => {
  it("length-prefixes each component with 4 little-endian bytes", () => {
    const bytes = toSignedString("ab", "", "é");
    expect([...bytes]).toEqual([2, 0, 0, 0, 0x61, 0x62, 0, 0, 0, 0, 2, 0, 0, 0, 0xc3, 0xa9]);
  });
});

describe("createCallbackVerifier", () => {
  it("verifies a well-formed save callback and exposes the event", async () => {
    const g = googleSide();
    const { v, fetches } = verifier(g);
    const result = await v.verify(JSON.stringify(g.message()), { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      classId: `${ISSUER}.collection_v1`,
      objectId: `${ISSUER}.s3r1al.0123456789abcdef`,
      eventType: "save",
      expTimeMillis: NOW + HOUR,
      nonce: "nonce-1",
    });
    expect(result.event.raw.eventType).toBe("save");
    const del = await v.verify(JSON.stringify(g.message({ eventType: "del", nonce: "nonce-2" })));
    expect(del.ok && del.event.eventType).toBe("del");
    // Headers as a Headers object work too.
    expect((await v.verify(JSON.stringify(g.message({ nonce: "n3" })), new Headers({ "User-Agent": "Google-Valuables" }))).ok).toBe(true);
    expect(fetches()).toBe(1);
  });

  it("refuses each tampering with a named reason", async () => {
    const g = googleSide();
    const { v } = verifier(g);
    const refusal = async (body: unknown) => {
      const r = await v.verify(typeof body === "string" ? body : JSON.stringify(body));
      expect(r.ok).toBe(false);
      return r.ok ? "accepted" : r.reason;
    };
    const good = g.message();
    expect(await refusal("not json")).toBe("invalid_body");
    expect(await refusal("[]")).toBe("invalid_body");
    expect(await refusal({ ...good, intermediateSigningKey: undefined })).toBe("invalid_body");
    expect(await refusal({ ...good, protocolVersion: "ECv1" })).toBe("unsupported_protocol");
    // The signed message tampered after signing.
    expect(await refusal({ ...good, signedMessage: good.signedMessage.replace('"save"', '"del"') })).toBe("signature_invalid");
    // The message signature itself tampered.
    const sigBytes = Buffer.from(good.signature, "base64");
    sigBytes[sigBytes.length - 1] = sigBytes[sigBytes.length - 1]! ^ 0x01;
    expect(await refusal({ ...good, signature: sigBytes.toString("base64") })).toBe("signature_invalid");
    expect(await refusal({ ...good, signature: "AAAA" })).toBe("signature_invalid");
    // The intermediate key's signature tampered, or signed by a key Google never published.
    expect(await refusal({ ...good, intermediateSigningKey: { ...good.intermediateSigningKey, signatures: ["AAAA"] } })).toBe("intermediate_key_unverified");
    const rogue = googleSide();
    expect(await refusal(rogue.message())).toBe("intermediate_key_unverified");
    // An intermediate key swapped for another while keeping the root signature: the signature no longer covers it.
    expect(await refusal({ ...good, intermediateSigningKey: { ...good.intermediateSigningKey, signedKey: rogue.signedKey } })).toBe("intermediate_key_unverified");
    // Signed for another recipient (another issuer id).
    expect(await refusal(g.message({}, { recipient: "1111111111111111111" }))).toBe("signature_invalid");
    // Signed under another protocol string.
    expect(await refusal(g.message({}, { protocol: "ECv2" }))).toBe("unsupported_protocol");
    // Signed by a key other than the certified intermediate.
    expect(await refusal(g.message({}, { signer: p256().privateKey }))).toBe("signature_invalid");
    // Expired message.
    expect(await refusal(g.message({ expTimeMillis: String(NOW - 1) }))).toBe("message_expired");
    // Message shape.
    expect(await refusal(g.message({ eventType: "update" }))).toBe("message_invalid");
    expect(await refusal(g.message({ nonce: "" }))).toBe("message_invalid");
    expect(await refusal(g.message({ objectId: 5 }))).toBe("message_invalid");
    // Expired intermediate key.
    const stale = googleSide({ intermediateExpiresAt: NOW - 1 });
    const { v: v2 } = verifier(stale);
    const r = await v2.verify(JSON.stringify(stale.message()));
    expect(r.ok ? "accepted" : r.reason).toBe("intermediate_key_expired");
  });

  it("deduplicates on the nonce when given a store, with a TTL to the message expiry", async () => {
    const g = googleSide();
    const written: Array<{ key: string; ttl: number }> = [];
    const inner = memoryCallbackNonceStore({ now: () => NOW });
    const store = {
      async set(key: string, value: string, opts: { ttlSeconds: number; onlyIfAbsent: true }) {
        written.push({ key, ttl: opts.ttlSeconds });
        return inner.set(key, value, opts);
      },
    };
    const { v } = verifier(g, { nonceStore: store });
    const body = JSON.stringify(g.message());
    expect((await v.verify(body)).ok).toBe(true);
    const again = await v.verify(body);
    expect(again.ok ? "accepted" : again.reason).toBe("nonce_replayed");
    expect(written).toHaveLength(2);
    expect(written[0]!.key).toBe(`erc8426:google:callback:${ISSUER}:nonce-1`);
    expect(written[0]!.ttl).toBe(3600);
    // A different nonce is a different event.
    expect((await v.verify(JSON.stringify(g.message({ nonce: "nonce-2" })))).ok).toBe(true);
    // The store forgets a nonce once its message has expired.
    const late = memoryCallbackNonceStore({ now: () => NOW + 2 * HOUR });
    expect(await late.set("k", "1", { ttlSeconds: 1, onlyIfAbsent: true })).toBe(true);
    expect(await late.set("k", "1", { ttlSeconds: 1, onlyIfAbsent: true })).toBe(false);
  });

  it("fetches the root keys once and reuses them until the cache expires, sharing one fetch between concurrent callers", async () => {
    const g = googleSide();
    let t = NOW;
    let fetches = 0;
    const v = createCallbackVerifier({
      issuerId: ISSUER,
      now: () => t,
      keyCacheSeconds: 60,
      fetchKeys: async () => {
        fetches += 1;
        return g.rootKeys;
      },
    });
    const body = JSON.stringify(g.message());
    const results = await Promise.all([v.verify(body), v.verify(body), v.verify(body)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fetches).toBe(1);
    t += 59_000;
    await v.verify(body);
    expect(fetches).toBe(1);
    t += 2_000;
    await v.verify(body);
    expect(fetches).toBe(2);
    // A max-age in the key response wins over the configured TTL.
    let fetches2 = 0;
    let t2 = NOW;
    const v2 = createCallbackVerifier({ issuerId: ISSUER, now: () => t2, keyCacheSeconds: 60, fetchKeys: async () => (fetches2 += 1, { ...g.rootKeys, maxAgeSeconds: 10 }) });
    await v2.verify(body);
    t2 += 11_000;
    await v2.verify(body);
    expect(fetches2).toBe(2);
    expect(maxAgeOf("public, max-age=1800, must-revalidate")).toBe(1800);
    expect(maxAgeOf(null)).toBeUndefined();
  });

  it("reports unavailable keys as retryable and uses the default fetcher against Google's URL", async () => {
    const g = googleSide();
    const failing = createCallbackVerifier({ issuerId: ISSUER, now: () => NOW, fetchKeys: async () => { throw new Error("offline"); } });
    const r = await failing.verify(JSON.stringify(g.message()));
    expect(r.ok ? "accepted" : r.reason).toBe("keys_unavailable");
    const calls: string[] = [];
    const v = createCallbackVerifier({
      issuerId: ISSUER,
      now: () => NOW,
      fetch: (async (input: string | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ keys: g.rootKeys.keys }), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
      }) as unknown as typeof fetch,
    });
    expect((await v.verify(JSON.stringify(g.message()))).ok).toBe(true);
    expect(calls).toEqual([GOOGLE_ROOT_KEYS_URL]);
    expect(() => createCallbackVerifier({ issuerId: "BCR2DN4T", fetchKeys: async () => g.rootKeys })).toThrow(/numeric/);
  });

  it("warns, and still verifies, when the User-Agent is not Google's", async () => {
    const g = googleSide();
    const warnings: string[] = [];
    const { v } = verifier(g, { onWarning: (m) => warnings.push(m) });
    expect((await v.verify(JSON.stringify(g.message()), { "user-agent": "curl/8.0" })).ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("curl/8.0");
    expect((await v.verify(JSON.stringify(g.message({ nonce: "n2" })), { "user-agent": "Googlebot" })).ok).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe("review regressions", () => {
  it("a handler that throws releases the nonce, so Google's redelivery is handled instead of lost", async () => {
    const g = googleSide();
    const { v } = verifier(g, { nonceStore: memoryCallbackNonceStore({ now: () => NOW }) });
    let calls = 0;
    const handle = callbackHandler(v, () => {
      calls++;
      if (calls === 1) throw new Error("db down");
    });
    const body = JSON.stringify(g.message());
    const first = await handle(new Request("https://x/cb", { method: "POST", body }));
    expect(first.status).toBe(503);
    const redelivered = await handle(new Request("https://x/cb", { method: "POST", body }));
    expect(redelivered.status).toBe(200);
    expect(await redelivered.json()).toEqual({ ok: true });
    expect(calls).toBe(2);
    // Once handled, a further redelivery is the duplicate it is.
    const third = await handle(new Request("https://x/cb", { method: "POST", body }));
    expect(await third.json()).toMatchObject({ ok: false, error: "nonce_replayed" });
    expect(calls).toBe(2);
    // verify() exposes release() for callers that drive it themselves; without a store it is a no-op.
    const plain = verifier(g).v;
    const r = await plain.verify(JSON.stringify(g.message({ nonce: "n9" })));
    expect(r.ok).toBe(true);
    if (r.ok) await expect(r.release()).resolves.toBeUndefined();
  });

  it("a root key rotated in after the cache filled is picked up by one early refetch, rate capped", async () => {
    const g1 = googleSide();
    const g2 = googleSide();
    let set = g1.rootKeys;
    let fetches = 0;
    let t = NOW;
    const v = createCallbackVerifier({
      issuerId: ISSUER,
      now: () => t,
      keyRefreshFloorSeconds: 60,
      fetchKeys: async () => {
        fetches += 1;
        return set;
      },
      onWarning: () => undefined,
    });
    expect((await v.verify(JSON.stringify(g1.message()))).ok).toBe(true);
    expect(fetches).toBe(1);
    // Google adds a root; a message under it arrives before the cache expired.
    set = { keys: [...g1.rootKeys.keys, ...g2.rootKeys.keys] };
    const r = await v.verify(JSON.stringify(g2.message({ nonce: "n2" })));
    expect(r.ok).toBe(true);
    expect(fetches).toBe(2);
    // An unverifiable message right after does not trigger another fetch within the floor.
    const rogue = googleSide();
    const refused = await v.verify(JSON.stringify(rogue.message({ nonce: "n3" })));
    expect(refused.ok ? "accepted" : refused.reason).toBe("intermediate_key_unverified");
    expect(fetches).toBe(2);
    t += 61_000;
    const refusedLater = await v.verify(JSON.stringify(rogue.message({ nonce: "n4" })));
    expect(refusedLater.ok ? "accepted" : refusedLater.reason).toBe("intermediate_key_unverified");
    expect(fetches).toBe(3);
    // A root key with no finite keyExpiration is ignored.
    const noExpiry = createCallbackVerifier({
      issuerId: ISSUER,
      now: () => NOW,
      fetchKeys: async () => ({ keys: [{ keyValue: g1.root.keyValue, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: "" }] }),
      onWarning: () => undefined,
    });
    const noExp = await noExpiry.verify(JSON.stringify(g1.message({ nonce: "n5" })));
    expect(noExp.ok ? "accepted" : noExp.reason).toBe("intermediate_key_unverified");
  });

  it("an intermediate key without a finite keyExpiration is refused", async () => {
    const g = googleSide();
    const { v } = verifier(g);
    for (const signedKey of [JSON.stringify({ keyValue: g.intermediate.keyValue }), JSON.stringify({ keyValue: g.intermediate.keyValue, keyExpiration: "soon" }), JSON.stringify({ keyValue: g.intermediate.keyValue, keyExpiration: null })]) {
      const m = g.message();
      m.intermediateSigningKey = { signedKey, signatures: [ecdsa(g.root.privateKey, toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, CALLBACK_PROTOCOL_VERSION, signedKey))] };
      const r = await v.verify(JSON.stringify(m));
      expect(r.ok ? "accepted" : r.reason, signedKey).toBe("intermediate_key_unverified");
    }
    // A numeric keyExpiration is fine.
    const numeric = JSON.stringify({ keyValue: g.intermediate.keyValue, keyExpiration: NOW + HOUR });
    const m = g.message();
    m.intermediateSigningKey = { signedKey: numeric, signatures: [ecdsa(g.root.privateKey, toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, CALLBACK_PROTOCOL_VERSION, numeric))] };
    const sig = ecdsa(g.intermediate.privateKey, toSignedString(GOOGLE_PAY_PASSES_SENDER_ID, ISSUER, CALLBACK_PROTOCOL_VERSION, m.signedMessage));
    expect((await v.verify(JSON.stringify({ ...m, signature: sig }))).ok).toBe(true);
  });

  it("the handler caps the body it reads", async () => {
    const g = googleSide();
    const handle = callbackHandler(verifier(g).v, () => undefined);
    expect(MAX_CALLBACK_BODY_BYTES).toBe(16 * 1024);
    const big = await handle(new Request("https://x/cb", { method: "POST", body: "x".repeat(MAX_CALLBACK_BODY_BYTES + 1) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ ok: false, error: "payload_too_large" });
    const declared = await handle(new Request("https://x/cb", { method: "POST", headers: { "content-length": String(MAX_CALLBACK_BODY_BYTES + 1) }, body: "{}" }));
    expect(declared.status).toBe(413);
    expect((await handle(new Request("https://x/cb", { method: "POST", body: JSON.stringify(g.message()) }))).status).toBe(200);
  });
});

describe("callbackHandler", () => {
  it("answers 200 for a verified event, 4xx for a refusal, 503 when keys are unavailable, and 200 for a redelivered nonce", async () => {
    const g = googleSide();
    const events: CallbackEvent[] = [];
    const { v } = verifier(g, { nonceStore: memoryCallbackNonceStore({ now: () => NOW }) });
    const handler = callbackHandler(v, (e) => {
      events.push(e);
    });
    const post = (body: string, h: (req: Request) => Promise<Response> = handler) =>
      h(new Request("https://issuer.example/google/callback", { method: "POST", headers: { "content-type": "application/json", "user-agent": "Googlebot" }, body }));
    const ok = await post(JSON.stringify(g.message()));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("save");
    // Redelivery of the same message: acknowledged, not handled twice.
    const again = await post(JSON.stringify(g.message()));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: false, error: "nonce_replayed" });
    expect(events).toHaveLength(1);
    const bad = await post(JSON.stringify(g.message({ nonce: "n2" }, { recipient: "1111111111111111111" })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "signature_invalid" });
    expect((await post("nope")).status).toBe(400);
    expect((await handler(new Request("https://issuer.example/google/callback"))).status).toBe(405);
    const offline = callbackHandler(createCallbackVerifier({ issuerId: ISSUER, now: () => NOW, fetchKeys: async () => { throw new Error("offline"); } }), () => undefined);
    expect((await post(JSON.stringify(g.message({ nonce: "n3" })), offline)).status).toBe(503);
    const throwing = callbackHandler(verifier(g).v, () => { throw new Error("db down"); });
    expect((await post(JSON.stringify(g.message({ nonce: "n4" })), throwing)).status).toBe(503);
  });
});
