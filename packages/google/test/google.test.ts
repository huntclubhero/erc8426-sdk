import { generateKeyPairSync } from "node:crypto";

import { GOOGLE_SAVE_URL_PREFIX, type PassContent, type PassContext, tokenRef } from "@erc8426/core";
import {
  GoogleImageError,
  GoogleWalletApiError,
  MAX_TEXT_MODULES,
  TOKEN_URL,
  WALLET_API,
  WALLET_SCOPE,
  assertIssuerId,
  createSaveUrl,
  googleFormatProvider,
  googleWalletClient,
  saveOrigins,
  stateFor,
  suffixForSerial,
  toGoogleClass,
  toGoogleObject,
  type ServiceAccount,
} from "@erc8426/google";
import { decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const ISSUER = "3388000000012345678";
const OWNER_A = "0x2B7E9A4c1F0d8e63A5b2C4D6E8F0A1b3C5d7E9F2";
const OWNER_B = "0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1";

let sa: ServiceAccount;
let publicPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  sa = { client_email: "wallet@example-project.iam.gserviceaccount.com", private_key: privateKey };
  publicPem = publicKey;
});

function content(overrides: Partial<PassContent> = {}): PassContent {
  return {
    serial: "s3r1al",
    style: "generic",
    organizationName: "Example Org",
    description: "Example pass",
    title: "EXAMPLE",
    colors: { background: "#101418", foreground: "#ffffff" },
    images: { logo: { url: "https://cdn.example/logo.png" }, hero: { url: "https://cdn.example/hero.png?v=3" } },
    header: [{ key: "no", label: "NO.", value: 412 }],
    primary: [
      { key: "bal", label: "BALANCE", value: "12" },
      { key: "tier", label: "TIER", value: "Gold" },
    ],
    secondary: [{ key: "st", label: "STATUS", value: "Active" }],
    back: [{ key: "about", label: "About", value: "An example." }],
    links: [{ key: "act", label: "Do the thing", url: "https://issuer.example/a?x=1" }],
    barcode: { format: "qr", message: "https://issuer.example/t/412", altText: "412" },
    ...overrides,
  };
}

const opts = { issuerId: ISSUER, classSuffix: "collection_v1" };

function ctx(owner: string, c: PassContent = content()): PassContext {
  return { token: tokenRef(1, OWNER_B, 412), owner: owner as `0x${string}`, content: c };
}

async function verifySaveJwt(url: string): Promise<JWTPayload & { payload: Record<string, unknown[]>; origins: string[]; typ: string }> {
  expect(url.startsWith(GOOGLE_SAVE_URL_PREFIX)).toBe(true);
  const jwt = url.slice(GOOGLE_SAVE_URL_PREFIX.length);
  expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
  const { payload } = await jwtVerify(jwt, await importSPKI(publicPem, "RS256"), { issuer: sa.client_email, audience: "google" });
  return payload as never;
}

describe("object mapping", () => {
  it("maps generic to cardTitle, header, subheader, logo, hero, modules and links", () => {
    const { vertical, resource } = toGoogleObject(content(), opts);
    expect(vertical).toBe("generic");
    expect(resource).toMatchObject({
      id: `${ISSUER}.s3r1al`,
      classId: `${ISSUER}.collection_v1`,
      state: "ACTIVE",
      cardTitle: { defaultValue: { language: "en-US", value: "EXAMPLE" } },
      header: { defaultValue: { language: "en-US", value: "12" } },
      subheader: { defaultValue: { language: "en-US", value: "BALANCE" } },
      hexBackgroundColor: "#101418",
      logo: { sourceUri: { uri: "https://cdn.example/logo.png" } },
      heroImage: { sourceUri: { uri: "https://cdn.example/hero.png?v=3" } },
      barcode: { type: "QR_CODE", value: "https://issuer.example/t/412", alternateText: "412" },
      linksModuleData: { uris: [{ id: "act", uri: "https://issuer.example/a?x=1", description: "Do the thing" }] },
    });
    // The consumed primary field is not repeated; the rest keep their order.
    expect((resource.textModulesData as Array<{ id: string }>).map((m) => m.id)).toEqual(["tier", "no", "st", "about"]);
  });

  it("maps storeCard to a loyalty object with points", () => {
    const { vertical, resource } = toGoogleObject(content({ style: "storeCard" }), opts);
    expect(vertical).toBe("loyalty");
    expect(resource.loyaltyPoints).toEqual({ label: "BALANCE", balance: { string: "12" } });
    expect(resource.secondaryLoyaltyPoints).toEqual({ label: "TIER", balance: { string: "Gold" } });
    expect(resource.accountName).toBe("EXAMPLE");
    expect(resource.cardTitle).toBeUndefined();
    expect(resource.hexBackgroundColor).toBeUndefined();
    expect((resource.textModulesData as Array<{ id: string }>).map((m) => m.id)).toEqual(["no", "st", "about"]);
  });

  it("maps eventTicket and coupon to their verticals", () => {
    const ev = toGoogleObject(content({ style: "eventTicket", event: { name: "The Show", venue: "Hall" } }), opts);
    expect(ev.vertical).toBe("eventTicket");
    expect((ev.resource.textModulesData as Array<{ id: string; body: string }>).find((m) => m.id === "venue")?.body).toBe("Hall");
    expect(toGoogleObject(content({ style: "coupon" }), opts).vertical).toBe("offer");
  });

  it("builds a class per vertical, generic without review", () => {
    const generic = toGoogleClass(content(), opts);
    expect(generic.resource).toEqual({ id: `${ISSUER}.collection_v1`, multipleDevicesAndHoldersAllowedStatus: "ONE_USER_ALL_DEVICES" });
    const loyalty = toGoogleClass(content({ style: "storeCard" }), opts);
    expect(loyalty.resource).toMatchObject({
      issuerName: "Example Org",
      programName: "EXAMPLE",
      reviewStatus: "UNDER_REVIEW",
      programLogo: { sourceUri: { uri: "https://cdn.example/logo.png" } },
    });
    const startsAt = new Date("2031-05-06T19:30:00Z");
    const ev = toGoogleClass(content({ style: "eventTicket", event: { name: "The Show", startsAt } }), opts);
    expect(ev.resource).toMatchObject({ eventName: { defaultValue: { value: "The Show" } }, dateTime: { start: startsAt.toISOString() } });
    const offer = toGoogleClass(content({ style: "coupon" }), { ...opts, overrides: { callbackOptions: { url: "https://issuer.example/cb" } } });
    expect(offer.resource).toMatchObject({ provider: "Example Org", redemptionChannel: "ONLINE", callbackOptions: { url: "https://issuer.example/cb" } });
    expect(() => toGoogleClass(content({ style: "storeCard", images: {} }), opts)).toThrow(GoogleImageError);
  });

  it("marks voided passes INACTIVE and expired passes EXPIRED", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(stateFor(content(), now)).toBe("ACTIVE");
    expect(stateFor(content({ voided: true }), now)).toBe("INACTIVE");
    expect(stateFor(content({ expiresAt: new Date("2029-12-31T00:00:00Z") }), now)).toBe("EXPIRED");
    expect(stateFor(content({ expiresAt: new Date("2030-01-02T00:00:00Z") }), now)).toBe("ACTIVE");
    const o = toGoogleObject(content({ expiresAt: new Date("2029-12-31T00:00:00Z") }), { ...opts, now });
    expect(o.resource.state).toBe("EXPIRED");
    expect(o.resource.validTimeInterval).toEqual({ end: { date: "2029-12-31T00:00:00.000Z" } });
  });

  it("caps text modules at Google's limit", () => {
    const back = Array.from({ length: 20 }, (_, i) => ({ key: `b${i}`, label: `B${i}`, value: i }));
    const o = toGoogleObject(content({ back }), opts);
    expect(o.resource.textModulesData).toHaveLength(MAX_TEXT_MODULES);
  });

  it("refuses images Google cannot fetch", () => {
    const bad: Array<[PassContent["images"], RegExp]> = [
      [{ hero: { data: new Uint8Array([1]) } }, /no url/],
      [{ hero: { url: "http://cdn.example/h.png" } }, /https/],
      [{ hero: { url: "https://localhost:3000/h.png" } }, /publicly reachable/],
      [{ hero: { url: "https://127.0.0.1/h.png" } }, /publicly reachable/],
      [{ hero: { url: "https://192.168.1.4/h.png" } }, /publicly reachable/],
      [{ hero: { url: "https://[::1]/h.png" } }, /publicly reachable/],
      [{ hero: { url: "not a url" } }, /valid URL/],
    ];
    for (const [images, re] of bad) {
      expect(() => toGoogleObject(content({ images }), opts)).toThrow(re);
    }
    const omitted = toGoogleObject(content({ images: { hero: { data: new Uint8Array([1]) } } }), { ...opts, unhostedImages: "omit" });
    expect(omitted.resource.heroImage).toBeUndefined();
  });

  it("validates ids and keeps distinct serials distinct", () => {
    expect(() => assertIssuerId("BCR2DN4TXXXX")).toThrow(/numeric issuer id/);
    expect(() => toGoogleObject(content(), { ...opts, classSuffix: "bad suffix" })).toThrow(/suffix/);
    expect(() => toGoogleObject(content(), { ...opts, objectSuffix: "a/b" })).toThrow(/object suffix/);
    expect(suffixForSerial("abc-1_2.3")).toBe("abc-1_2.3");
    expect(suffixForSerial("a b")).not.toBe(suffixForSerial("a+b"));
    expect(suffixForSerial("a b")).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("save links", () => {
  it("signs a savetowallet JWT that verifies and carries references", async () => {
    const now = new Date();
    const url = await createSaveUrl({
      serviceAccount: sa,
      origins: ["https://issuer.example"],
      objectIds: [{ vertical: "generic", id: `${ISSUER}.s3r1al`, classId: `${ISSUER}.collection_v1` }],
      now,
    });
    const claims = await verifySaveJwt(url);
    expect(claims.typ).toBe("savetowallet");
    expect(claims.origins).toEqual(["https://issuer.example"]);
    expect(claims.payload).toEqual({ genericObjects: [{ id: `${ISSUER}.s3r1al`, classId: `${ISSUER}.collection_v1` }] });
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it("embeds fat objects and classes under their vertical keys, and can omit exp", async () => {
    const obj = toGoogleObject(content({ style: "storeCard" }), opts);
    const cls = toGoogleClass(content({ style: "storeCard" }), opts);
    const url = await createSaveUrl({ serviceAccount: sa, origins: ["https://issuer.example"], objects: [obj], classes: [cls], ttlSeconds: null });
    const claims = await verifySaveJwt(url);
    expect(Object.keys(claims.payload).sort()).toEqual(["loyaltyClasses", "loyaltyObjects"]);
    expect(claims.exp).toBeUndefined();
  });

  it("rejects an expired link and a non-origin", async () => {
    const url = await createSaveUrl({
      serviceAccount: sa,
      origins: ["https://issuer.example"],
      objectIds: [{ vertical: "generic", id: `${ISSUER}.x`, classId: `${ISSUER}.c` }],
      ttlSeconds: 60,
      now: new Date(Date.now() - 3600_000),
    });
    await expect(verifySaveJwt(url)).rejects.toThrow(/exp/);
    await expect(
      createSaveUrl({ serviceAccount: sa, origins: ["https://issuer.example/path"], objectIds: [{ vertical: "generic", id: "1.x", classId: "1.c" }] }),
    ).rejects.toThrow(/bare origin/);
  });

  it("allowlists the www variant of each origin", () => {
    expect(saveOrigins(["https://issuer.example/app", "https://www.other.example", "http://localhost:3000"])).toEqual([
      "https://issuer.example",
      "https://www.issuer.example",
      "https://www.other.example",
      "https://other.example",
      "http://localhost:3000",
    ]);
  });
});

/// An in-memory Wallet API behind a fetch function: the token endpoint
///  verifies the service account assertion, resources are keyed by type and
///  id, and every call is recorded.
function fakeGoogle() {
  const resources = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
  const messages: Array<{ path: string; body: any }> = [];
  let tokenGrants = 0;
  let failNextUpsert = false;
  const reject401 = new Set<string>();

  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const { payload } = await jwtVerify(form.get("assertion")!, await importSPKI(publicPem, "RS256"), {
        issuer: sa.client_email,
        audience: TOKEN_URL,
        subject: sa.client_email,
      });
      expect(payload.scope).toBe(WALLET_SCOPE);
      tokenGrants += 1;
      return Response.json({ access_token: `tok-${tokenGrants}`, expires_in: 3600, token_type: "Bearer" });
    }
    expect(url.startsWith(`${WALLET_API}/`)).toBe(true);
    const path = decodeURIComponent(url.slice(WALLET_API.length + 1));
    const auth = (init.headers as Record<string, string>).authorization;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, auth });
    if (auth && reject401.has(auth.replace("Bearer ", ""))) return new Response("unauthorized", { status: 401 });
    const parts = path.split("/");
    if (parts.length === 3 && parts[2] === "addMessage") {
      messages.push({ path, body });
      return Response.json({});
    }
    if (method === "POST" && parts.length === 1) {
      if (failNextUpsert) {
        failNextUpsert = false;
        return new Response("boom", { status: 500 });
      }
      const key = `${parts[0]}/${body.id}`;
      if (resources.has(key)) return Response.json({ error: { code: 409 } }, { status: 409 });
      resources.set(key, body);
      return Response.json(body);
    }
    const existing = resources.get(path);
    if (!existing) return Response.json({ error: { code: 404 } }, { status: 404 });
    if (method === "GET") return Response.json(existing);
    if (method === "PATCH") {
      const merged = { ...existing, ...body };
      resources.set(path, merged);
      return Response.json(merged);
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchFn,
    resources,
    calls,
    messages,
    reject401,
    get tokenGrants() {
      return tokenGrants;
    },
    failNext() {
      failNextUpsert = true;
    },
  };
}

describe("REST client", () => {
  it("exchanges a service account assertion once and reuses the token", async () => {
    const g = fakeGoogle();
    const client = googleWalletClient({ serviceAccount: sa, issuerId: ISSUER, fetch: g.fetch });
    const [a, b] = await Promise.all([client.accessToken(), client.accessToken()]);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    await client.get("genericClass", `${ISSUER}.c`);
    expect(g.tokenGrants).toBe(1);
    expect(g.calls[0]!.auth).toBe("Bearer tok-1");
  });

  it("inserts on 404, then patches on the next upsert", async () => {
    const g = fakeGoogle();
    const client = googleWalletClient({ serviceAccount: sa, issuerId: ISSUER, fetch: g.fetch });
    const obj = toGoogleObject(content(), opts);
    const first = await client.upsert("genericObject", obj.resource);
    expect(first.created).toBe(true);
    expect(g.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    const second = await client.upsert("genericObject", { ...obj.resource, state: "EXPIRED" });
    expect(second.created).toBe(false);
    expect(g.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "PATCH"]);
    expect(g.resources.get(`genericObject/${obj.resource.id}`)!.state).toBe("EXPIRED");
  });

  it("throws a typed error on failure and drops a rejected token", async () => {
    const g = fakeGoogle();
    const client = googleWalletClient({ serviceAccount: sa, issuerId: ISSUER, fetch: g.fetch });
    await expect(client.patch("genericObject", `${ISSUER}.missing`, {})).rejects.toBeInstanceOf(GoogleWalletApiError);
    g.reject401.add("tok-1");
    await expect(client.get("genericObject", `${ISSUER}.x`)).rejects.toMatchObject({ status: 401 });
    expect(await client.accessToken()).toBe("tok-2");
  });

  it("refuses a merchant id in place of the issuer id", () => {
    expect(() => googleWalletClient({ serviceAccount: sa, issuerId: "BCR2DN4TXXXX" })).toThrow(/numeric/);
  });
});

describe("googleFormatProvider", () => {
  function setup(extra: Partial<Parameters<typeof googleFormatProvider>[0]> = {}) {
    const g = fakeGoogle();
    const client = googleWalletClient({ serviceAccount: sa, issuerId: ISSUER, fetch: g.fetch });
    const errors: string[] = [];
    const p = googleFormatProvider({
      client,
      classSuffix: "collection_v1",
      origins: ["https://issuer.example"],
      onError: (_e, where) => errors.push(where),
      ...extra,
    });
    return { g, p, errors };
  }

  it("creates the class and object, then mints a thin save link", async () => {
    const { g, p } = setup();
    expect(p.format).toBe("google");
    const url = await p.acquisitionUrl(ctx(OWNER_A));
    const claims = await verifySaveJwt(url);
    const refs = claims.payload.genericObjects as Array<{ id: string; classId: string }>;
    expect(refs).toHaveLength(1);
    expect(Object.keys(refs[0]!).sort()).toEqual(["classId", "id"]);
    expect(refs[0]!.id).toMatch(new RegExp(`^${ISSUER}\\.s3r1al\\.[0-9a-f]{16}$`));
    expect(g.resources.has(`genericClass/${ISSUER}.collection_v1`)).toBe(true);
    expect(g.resources.has(`genericObject/${refs[0]!.id}`)).toBe(true);

    // A repeat claim reuses the object and skips the unchanged PATCH.
    const before = g.calls.length;
    const again = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    expect((again.payload.genericObjects as Array<{ id: string }>)[0]!.id).toBe(refs[0]!.id);
    expect(g.calls.length).toBe(before);
  });

  it("on transfer expires the previous owner's object and issues a new one", async () => {
    const { g, p } = setup();
    const first = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    const oldId = (first.payload.genericObjects as Array<{ id: string }>)[0]!.id;
    const second = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_B)));
    const newId = (second.payload.genericObjects as Array<{ id: string }>)[0]!.id;
    expect(newId).not.toBe(oldId);
    const old = g.resources.get(`genericObject/${oldId}`)!;
    expect(old.state).toBe("EXPIRED");
    expect(old.linksModuleData).toEqual({ uris: [] });
    expect(g.messages.map((m) => m.path)).toEqual([`genericObject/${oldId}/addMessage`]);
    expect(g.resources.get(`genericObject/${newId}`)!.state).toBe("ACTIVE");
  });

  it("notifyUpdate patches the object and attaches a message", async () => {
    const { g, p } = setup({ messageFor: () => ({ header: "Updated", body: "Balance moved" }) });
    const first = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    const id = (first.payload.genericObjects as Array<{ id: string }>)[0]!.id;
    await p.notifyUpdate!(ctx(OWNER_A, content({ headline: "Changed" })));
    expect((g.resources.get(`genericObject/${id}`)!.header as { defaultValue: { value: string } }).defaultValue.value).toBe("Changed");
    expect(g.messages.at(-1)!.body.message).toMatchObject({ header: "Updated", body: "Balance moved", messageType: "TEXT" });
  });

  it("rotate expires the object so the next acquisition issues a new id", async () => {
    const { g, p } = setup();
    const first = (await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)))).payload.genericObjects as Array<{ id: string }>;
    await p.rotate("s3r1al");
    expect(g.resources.get(`genericObject/${first[0]!.id}`)!.state).toBe("EXPIRED");
    const next = (await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)))).payload.genericObjects as Array<{ id: string }>;
    expect(next[0]!.id).not.toBe(first[0]!.id);
  });

  it("a superseded serial (voided, as the issuer sends on owner rotation) expires the shared object and clears its links, once", async () => {
    const { g, p } = setup();
    const first = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    const id = (first.payload.genericObjects as Array<{ id: string }>)[0]!.id;
    expect(JSON.stringify(g.resources.get(`genericObject/${id}`))).toContain("https://issuer.example/a?x=1");

    // The issuer minted a new serial and voids this one: same owner, no links.
    await p.notifyUpdate!(ctx(OWNER_A, content({ voided: true, links: [] })));
    const obj = g.resources.get(`genericObject/${id}`)!;
    expect(obj.state).toBe("EXPIRED");
    expect(obj.linksModuleData).toEqual({ uris: [] });
    expect(JSON.stringify(obj)).not.toContain("https://issuer.example/a?x=1");
    expect(g.messages.map((m) => m.path)).toEqual([`genericObject/${id}/addMessage`]);
    expect(g.messages[0]!.body.message.body).toMatch(/^A newer pass replaced this one/);

    // Idempotent: a repeat notify sends no second message.
    await p.notifyUpdate!(ctx(OWNER_A, content({ voided: true, links: [] })));
    expect(g.messages).toHaveLength(1);

    // The new serial the issuer minted gets its own object.
    const fresh = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A, content({ serial: "n3w" }))));
    expect((fresh.payload.genericObjects as Array<{ id: string }>)[0]!.id).not.toBe(id);
  });

  it("clears removed links and modules on PATCH, since PATCH merges", async () => {
    const { g, p } = setup();
    const first = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    const id = (first.payload.genericObjects as Array<{ id: string }>)[0]!.id;
    await p.notifyUpdate!(ctx(OWNER_A, content({ links: [], header: [], primary: [], secondary: [], back: [] })));
    const obj = g.resources.get(`genericObject/${id}`)!;
    expect(obj.linksModuleData).toEqual({ uris: [] });
    expect(obj.textModulesData).toEqual([]);
    expect(obj.state).toBe("ACTIVE");
  });

  it("falls back to a fat link when the REST upsert fails, and reports it", async () => {
    const { g, p, errors } = setup();
    // Class creation succeeds; the object insert fails.
    await p.acquisitionUrl(ctx(OWNER_A, content({ serial: "warm" })));
    g.failNext();
    const claims = await verifySaveJwt(await p.acquisitionUrl(ctx(OWNER_A)));
    expect(Object.keys(claims.payload).sort()).toEqual(["genericClasses", "genericObjects"]);
    expect((claims.payload.genericObjects![0] as { cardTitle?: unknown }).cardTitle).toBeDefined();
    expect(errors.some((e) => e.startsWith("upsert object"))).toBe(true);
    const strict = setup({ fatLinkFallback: false });
    strict.g.failNext();
    await expect(strict.p.acquisitionUrl(ctx(OWNER_A))).rejects.toThrow(/could not be stored/);
  });
});
