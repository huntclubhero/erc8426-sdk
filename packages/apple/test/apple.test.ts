import { createHash, generateKeyPairSync } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import { PKPASS_MEDIA_TYPE, isPassFileProvider, type PassContent, type PassContext, tokenRef } from "@erc8426/core";
import {
  MemoryApplePassStore,
  applePassKitWebService,
  appleFormatProvider,
  supersededContent,
  buildPkpass,
  passImages,
  validateSignerCertificate,
  createApnsClient,
  fetchImage,
  isPng,
  isPrivateAddress,
  MAX_LOG_BODY_BYTES,
  hexToRgb,
  newPassRecord,
  rotatedRecord,
  toPassJson,
  type ApnsClient,
  type PushOutcome,
} from "@erc8426/apple";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import forge from "node-forge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TINY_PNG, makeTestCerts, makeTlsIdentity, unzip, type TestCerts } from "./helpers.js";

const PASS_TYPE = "pass.example.test";
const TEAM = "TEAM123456";
const OWNER_A = "0x2B7E9A4c1F0d8e63A5b2C4D6E8F0A1b3C5d7E9F2";
const OWNER_B = "0x5F9B5a1cdED9d6B3f5E8a2C47B0e13d6A8F4c2e1";
const PUSH_TOKEN = "a".repeat(64);
const publicDns = async () => ["93.184.216.34"];

let certs: TestCerts;
beforeAll(() => {
  certs = makeTestCerts();
});

function content(overrides: Partial<PassContent> = {}): PassContent {
  return {
    serial: "s3r1al",
    style: "storeCard",
    organizationName: "Example Org",
    description: "Example pass",
    title: "EXAMPLE",
    colors: { background: "#101418", foreground: "#ffffff", label: "#abc" },
    images: { icon: { data: TINY_PNG }, logo: { data: TINY_PNG, data2x: TINY_PNG }, hero: { data: TINY_PNG } },
    header: [{ key: "no", label: "NO.", value: 412 }],
    primary: [{ key: "bal", label: "BALANCE", value: "12", changeMessage: "Balance is now %@" }],
    secondary: [{ key: "st", label: "STATUS", value: "Active" }],
    back: [{ key: "about", label: "About", value: "An example." }],
    links: [{ key: "act", label: "Do the thing", url: "https://issuer.example/a?x=1&y=2" }],
    barcode: { format: "qr", message: "https://issuer.example/t/412", altText: "412" },
    ...overrides,
  };
}

function ctx(owner: string, c: PassContent = content()): PassContext {
  return { token: tokenRef(1, OWNER_B, 412), owner: owner as `0x${string}`, content: c };
}

describe("pass.json mapping", () => {
  const opts = { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM };

  it("maps each style to its own top-level key", () => {
    for (const style of ["generic", "eventTicket", "storeCard", "coupon"] as const) {
      const json = toPassJson(content({ style }), opts);
      expect(json[style]).toBeDefined();
      for (const other of ["generic", "eventTicket", "storeCard", "coupon"].filter((s) => s !== style)) {
        expect(json[other]).toBeUndefined();
      }
    }
  });

  it("maps identity, colors, barcode, fields and links", () => {
    const json = toPassJson(content(), opts) as Record<string, any>;
    expect(json).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE,
      teamIdentifier: TEAM,
      serialNumber: "s3r1al",
      organizationName: "Example Org",
      description: "Example pass",
      logoText: "EXAMPLE",
      sharingProhibited: true,
      backgroundColor: "rgb(16,20,24)",
      foregroundColor: "rgb(255,255,255)",
      labelColor: "rgb(170,187,204)",
    });
    expect(json.barcodes).toEqual([
      { format: "PKBarcodeFormatQR", message: "https://issuer.example/t/412", messageEncoding: "iso-8859-1", altText: "412" },
    ]);
    expect(json.webServiceURL).toBeUndefined();
    const card = json.storeCard;
    expect(card.primaryFields[0]).toEqual({ key: "bal", label: "BALANCE", value: "12", changeMessage: "Balance is now %@" });
    expect(card.headerFields[0]).toEqual({ key: "no", label: "NO.", value: 412 });
    // Links lead the back and are anchors, with & escaped inside the href.
    expect(card.backFields[0]).toEqual({
      key: "act",
      label: "Do the thing",
      value: "Do the thing",
      attributedValue: '<a href="https://issuer.example/a?x=1&amp;y=2">Do the thing</a>',
    });
    expect(card.backFields[1]).toEqual({ key: "about", label: "About", value: "An example." });
  });

  it("maps expiry, voided, relevance and locations", () => {
    const json = toPassJson(
      content({
        expiresAt: new Date("2030-01-02T03:04:05.678Z"),
        voided: true,
        relevantDate: new Date("2029-01-01T00:00:00Z"),
        locations: Array.from({ length: 12 }, (_, i) => ({ latitude: i, longitude: -i, relevantText: "near" })),
      }),
      opts,
    ) as Record<string, any>;
    expect(json.expirationDate).toBe("2030-01-02T03:04:05Z");
    expect(json.voided).toBe(true);
    expect(json.relevantDate).toBe("2029-01-01T00:00:00Z");
    expect(json.locations).toHaveLength(10);
    expect(json.locations[0]).toEqual({ latitude: 0, longitude: -0, relevantText: "near" });
  });

  it("fills an event ticket from the event block", () => {
    const startsAt = new Date("2031-05-06T19:30:00Z");
    const json = toPassJson(
      content({ style: "eventTicket", primary: [], secondary: [], event: { name: "The Show", venue: "Hall", startsAt } }),
      opts,
    ) as Record<string, any>;
    expect(json.eventTicket.primaryFields[0]).toMatchObject({ key: "event", value: "The Show" });
    expect(json.eventTicket.secondaryFields[0]).toMatchObject({ key: "venue", value: "Hall" });
    expect(json.eventTicket.auxiliaryFields[0]).toMatchObject({ key: "starts", value: "2031-05-06T19:30:00Z", dateStyle: "PKDateStyleMedium" });
    expect(json.relevantDate).toBe("2031-05-06T19:30:00Z");
  });

  it("requires a long enough token alongside webServiceURL", () => {
    expect(() => toPassJson(content(), { ...opts, webServiceURL: "https://issuer.example/apple" })).toThrow(/authenticationToken/);
    const json = toPassJson(content(), { ...opts, webServiceURL: "https://issuer.example/apple", authenticationToken: "t".repeat(32) });
    expect(json.webServiceURL).toBe("https://issuer.example/apple");
  });

  it("refuses duplicate keys, which Apple would drop silently", () => {
    expect(() => toPassJson(content({ links: [{ key: "about", label: "x", url: "https://issuer.example/x" }] }), opts)).toThrow(/duplicate/);
  });

  it("converts short and long hex", () => {
    expect(hexToRgb("#fff")).toBe("rgb(255,255,255)");
    expect(hexToRgb("0E2A3A")).toBe("rgb(14,42,58)");
    expect(() => hexToRgb("blue")).toThrow();
  });
});

describe("posterGeneric (iOS 27)", () => {
  const opts = { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM };
  const poster = (overrides: Partial<PassContent> = {}) =>
    content({
      style: "posterGeneric",
      header: [{ key: "no", label: "NO.", value: 412 }],
      primary: [
        { key: "bal", label: "BALANCE", value: "12" },
        { key: "tier", label: "TIER", value: "Gold" },
      ],
      secondary: [{ key: "st", label: "STATUS", value: "Active" }],
      footer: [{ key: "mood", label: "", value: "All good." }],
      images: { icon: { data: TINY_PNG }, logo: { data: TINY_PNG }, primaryLogo: { data: TINY_PNG }, artwork: { data: TINY_PNG }, hero: { data: TINY_PNG } },
      ...overrides,
    });

  it("emits the poster dictionary AND a generic fallback on the same pass", () => {
    const json = toPassJson(poster(), opts) as Record<string, any>;
    expect(Object.keys(json.posterGeneric).sort()).toEqual(["backFields", "footerFields", "headerFields", "primaryFields"]);
    expect(json.posterGeneric.headerFields.map((f: any) => f.key)).toEqual(["no"]);
    expect(json.posterGeneric.primaryFields.map((f: any) => f.key)).toEqual(["bal", "tier"]);
    expect(json.posterGeneric.footerFields).toEqual([{ key: "mood", label: "", value: "All good." }]);
    // The fallback is the full legacy layout, secondary row included; the poster face has no such row.
    expect(json.generic.secondaryFields.map((f: any) => f.key)).toEqual(["st"]);
    expect(json.generic.backFields[0].key).toBe("act");
    expect(json.posterGeneric.backFields).toEqual(json.generic.backFields);
    expect(json.storeCard).toBeUndefined();
  });

  it("uses the requested fallback style", () => {
    const json = toPassJson(poster({ posterFallback: "storeCard" }), opts) as Record<string, any>;
    expect(json.storeCard).toBeDefined();
    expect(json.generic).toBeUndefined();
  });

  it("refuses more than Apple's poster face shows, instead of letting the device drop fields", () => {
    expect(() => toPassJson(poster({ header: [{ key: "a", label: "A", value: 1 }, { key: "b", label: "B", value: 2 }] }), opts)).toThrow(/one header field/);
    expect(() => toPassJson(poster({ primary: ["a", "b", "c", "d", "e"].map((k) => ({ key: k, label: k, value: k })) }), opts)).toThrow(/four primary fields/);
    expect(() => toPassJson(poster({ footer: [{ key: "f1", label: "", value: "x" }, { key: "f2", label: "", value: "y" }] }), opts)).toThrow(/one footer field/);
  });

  it("refuses a footer on a style that has no footer row", () => {
    expect(() => toPassJson(content({ footer: [{ key: "f", label: "", value: "x" }] }), opts)).toThrow(/footer fields exist only on the posterGeneric style/);
  });

  it("refuses a footer key that collides with another field", () => {
    expect(() => toPassJson(poster({ footer: [{ key: "bal", label: "", value: "x" }] }), opts)).toThrow(/duplicate pass field key "bal"/);
  });

  it("ships artwork and primaryLogo plus the fallback style's own images", async () => {
    const withStoreCard = await passImages(poster({ posterFallback: "storeCard" }));
    expect(Object.keys(withStoreCard).sort()).toEqual(["artwork.png", "icon.png", "logo.png", "primaryLogo.png", "strip.png"]);
    const withGeneric = await passImages(poster());
    expect(Object.keys(withGeneric).sort()).toEqual(["artwork.png", "icon.png", "logo.png", "primaryLogo.png"]);
  });

  it("signs a poster pass whose emitted bundle carries both dictionaries and the footer", async () => {
    const bytes = await buildPkpass(poster(), { ...opts, certificates: { wwdr: certs.wwdr, signerCert: certs.signerCert, signerKey: certs.signerKey } });
    const files = unzip(bytes);
    const json = JSON.parse(files["pass.json"]!.toString("utf8"));
    expect(json.posterGeneric.footerFields[0].key).toBe("mood");
    expect(json.posterGeneric.primaryFields.map((f: any) => f.key)).toEqual(["bal", "tier"]);
    expect(json.generic.secondaryFields[0].key).toBe("st");
    expect(files["artwork.png"]).toBeDefined();
    expect(files["primaryLogo.png"]).toBeDefined();
  });
});

describe("buildPkpass", () => {
  it("refuses a signer certificate issued for another pass type or team", async () => {
    const base = { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM };
    const wrongType = makeTestCerts({ passTypeId: "pass.example.other" });
    await expect(
      buildPkpass(content(), { ...base, certificates: { wwdr: wrongType.wwdr, signerCert: wrongType.signerCert, signerKey: wrongType.signerKey } }),
    ).rejects.toThrow(/pass type "pass.example.other"/);
    const wrongTeam = makeTestCerts({ teamId: "OTHERTEAM1" });
    await expect(
      buildPkpass(content(), { ...base, certificates: { wwdr: wrongTeam.wwdr, signerCert: wrongTeam.signerCert, signerKey: wrongTeam.signerKey } }),
    ).rejects.toThrow(/team "OTHERTEAM1"/);
    // A certificate with no UID at all (a bare development certificate) carries nothing to compare.
    expect(() => validateSignerCertificate(makeTestCerts({ bare: true }).signerCert, base)).not.toThrow();
  });

  it("produces a signed bundle whose manifest covers every file", async () => {
    const bytes = await buildPkpass(content(), { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs });
    const files = unzip(bytes);
    expect(Object.keys(files).sort()).toEqual(
      ["icon.png", "logo.png", "logo@2x.png", "manifest.json", "pass.json", "signature", "strip.png"].sort(),
    );
    const manifest = JSON.parse(files["manifest.json"]!.toString()) as Record<string, string>;
    const covered = Object.keys(files).filter((n) => n !== "manifest.json" && n !== "signature");
    expect(Object.keys(manifest).sort()).toEqual(covered.sort());
    for (const name of covered) {
      expect(manifest[name]).toBe(createHash("sha1").update(files[name]!).digest("hex"));
    }
    const pass = JSON.parse(files["pass.json"]!.toString());
    expect(pass.serialNumber).toBe("s3r1al");
    expect(pass.storeCard.primaryFields[0].changeMessage).toBe("Balance is now %@");

    // The signature is a detached PKCS#7 by the signer certificate.
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(files["signature"]!.toString("binary"))) as forge.pkcs7.PkcsSignedData;
    const signerPem = forge.pki.certificateToPem(certs.signer);
    expect(p7.certificates.map((c) => forge.pki.certificateToPem(c))).toContain(signerPem);
  });

  it("signs a headline-only pass (the synthesized field survives signing)", async () => {
    const files = unzip(
      await buildPkpass(content({ primary: [], headline: "Hello" }), { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs }),
    );
    expect(JSON.parse(files["pass.json"]!.toString()).storeCard.primaryFields).toEqual([{ key: "headline", label: "", value: "Hello" }]);
  });

  it("ships no strip on generic, which has none", async () => {
    const files = unzip(await buildPkpass(content({ style: "generic" }), { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs }));
    expect(files["strip.png"]).toBeUndefined();
  });

  it("uses fallback images and refuses a pass with no icon", async () => {
    const noImages = content({ images: undefined });
    await expect(buildPkpass(noImages, { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs })).rejects.toThrow(/icon/);
    const files = unzip(
      await buildPkpass(noImages, { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs, images: { icon: { data: TINY_PNG } } }),
    );
    expect(files["icon.png"]).toBeDefined();
  });

  it("fetches url images with a size cap and PNG check", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("big.png")) return new Response(new Uint8Array(4096), { headers: { "content-length": "4096" } });
      if (url.endsWith("jpeg.png")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
      return new Response(TINY_PNG);
    }) as unknown as typeof fetch;
    const base = { passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs };
    const files = unzip(
      await buildPkpass(content({ images: { icon: { url: "https://cdn.example/icon.png" } } }), { ...base, imageFetch: { fetch: fakeFetch, lookup: publicDns } }),
    );
    expect(Buffer.from(files["icon.png"]!).equals(Buffer.from(TINY_PNG))).toBe(true);
    expect(seen).toEqual(["https://cdn.example/icon.png"]);
    await expect(
      buildPkpass(content({ images: { icon: { url: "https://cdn.example/big.png" } } }), { ...base, imageFetch: { fetch: fakeFetch, lookup: publicDns, maxBytes: 1024 } }),
    ).rejects.toThrow(/cap/);
    await expect(
      buildPkpass(content({ images: { icon: { url: "https://cdn.example/jpeg.png" } } }), { ...base, imageFetch: { fetch: fakeFetch, lookup: publicDns } }),
    ).rejects.toThrow(/PNG/);
    await expect(
      buildPkpass(content({ images: { icon: { url: "file:///etc/passwd" } } }), { ...base, imageFetch: { fetch: fakeFetch, lookup: publicDns } }),
    ).rejects.toThrow(/https/);
  });

  it("refuses image destinations on private networks, on every redirect hop (SSRF)", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/bounce.png")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      if (url.endsWith("/bounce-internal.png")) return new Response(null, { status: 302, headers: { location: "https://internal.example/x.png" } });
      if (url.endsWith("/hop.png")) return new Response(null, { status: 301, headers: { location: "/icon.png" } });
      return new Response(TINY_PNG);
    }) as unknown as typeof fetch;
    const dns = async (host: string) => (host === "internal.example" ? ["10.0.0.5"] : host === "mixed.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
    const go = (url: string, extra: Record<string, unknown> = {}) => fetchImage(url, { fetch: fakeFetch, lookup: dns, ...extra });
    await expect(go("http://cdn.example/icon.png")).rejects.toThrow(/https/);
    for (const url of [
      "https://127.0.0.1/x.png",
      "https://169.254.169.254/x.png",
      "https://[::1]/x.png",
      "https://[::ffff:10.0.0.1]/x.png",
      "https://localhost/x.png",
      "https://internal.example/x.png",
      "https://mixed.example/x.png",
    ]) {
      await expect(go(url)).rejects.toThrow(/private/);
    }
    await expect(go("https://cdn.example/bounce.png")).rejects.toThrow(/https/);
    await expect(go("https://cdn.example/bounce-internal.png")).rejects.toThrow(/private/);
    expect(seen).not.toContain("https://internal.example/x.png");
    // A public relative redirect is followed, and re-checked.
    expect(isPng(await go("https://cdn.example/hop.png"))).toBe(true);
    // Development escape hatch.
    expect(isPng(await go("http://localhost:3000/icon.png", { allowPrivateNetwork: true }))).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});

describe("PassKit web service", () => {
  const BASE = "https://issuer.example/wallet/apple";
  async function setup() {
    const store = new MemoryApplePassStore();
    const record = newPassRecord("s3r1al", OWNER_A);
    await store.putPass(record);
    const built: Array<{ retired: boolean; token: string }> = [];
    const handler = applePassKitWebService({
      store,
      passTypeIdentifier: PASS_TYPE,
      basePath: "/wallet/apple",
      buildPass: async (a) => {
        built.push({ retired: a.retired, token: a.authenticationToken });
        return new Uint8Array([1, 2, 3]);
      },
    });
    const call = (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      handler(
        new Request(`${BASE}${path}`, {
          method,
          headers: {
            ...(init.token ? { authorization: `ApplePass ${init.token}` } : {}),
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        }),
      );
    return { store, record, call, built };
  }
  const regPath = `/v1/devices/dev1/registrations/${PASS_TYPE}/s3r1al`;

  it("refuses a missing or wrong token with 401, and an unknown serial identically", async () => {
    const { call } = await setup();
    expect((await call("POST", regPath, { body: { pushToken: PUSH_TOKEN } })).status).toBe(401);
    expect((await call("POST", regPath, { token: "wrong".repeat(9), body: { pushToken: PUSH_TOKEN } })).status).toBe(401);
    expect((await call("GET", `/v1/passes/${PASS_TYPE}/nope`, { token: "x".repeat(43) })).status).toBe(401);
  });

  it("registers with 201, then 200 for the same device, and rejects a malformed push token", async () => {
    const { call, record, store } = await setup();
    expect((await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: "zz" } })).status).toBe(400);
    expect((await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN } })).status).toBe(201);
    expect((await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN } })).status).toBe(200);
    expect(await store.pushTokensForSerial(PASS_TYPE, "s3r1al")).toEqual([PUSH_TOKEN]);
  });

  it("answers 404 for another pass type", async () => {
    const { call, record } = await setup();
    const res = await call("POST", `/v1/devices/dev1/registrations/pass.other/s3r1al`, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN } });
    expect(res.status).toBe(404);
  });

  it("lists serials updated since the tag, 204 when none", async () => {
    const { call, record, store } = await setup();
    const listPath = `/v1/devices/dev1/registrations/${PASS_TYPE}`;
    expect((await call("GET", listPath)).status).toBe(204);
    await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN } });
    const first = await call("GET", listPath);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { serialNumbers: string[]; lastUpdated: string };
    expect(body.serialNumbers).toEqual(["s3r1al"]);
    expect((await call("GET", `${listPath}?passesUpdatedSince=${body.lastUpdated}`)).status).toBe(204);
    await store.putPass({ ...record, updatedAt: new Date(Number(body.lastUpdated) + 5) });
    const again = (await (await call("GET", `${listPath}?passesUpdatedSince=${body.lastUpdated}`)).json()) as { serialNumbers: string[] };
    expect(again.serialNumbers).toEqual(["s3r1al"]);
  });

  it("serves the latest pass with Last-Modified, and 304 when not modified", async () => {
    const { call, record, built } = await setup();
    const path = `/v1/passes/${PASS_TYPE}/s3r1al`;
    const res = await call("GET", path, { token: record.authenticationToken });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    const lastModified = res.headers.get("last-modified")!;
    expect(lastModified).toBe(record.updatedAt.toUTCString());
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(built).toEqual([{ retired: false, token: record.authenticationToken }]);
    const cached = await call("GET", path, { token: record.authenticationToken, headers: { "if-modified-since": lastModified } });
    expect(cached.status).toBe(304);
    const stale = await call("GET", path, {
      token: record.authenticationToken,
      headers: { "if-modified-since": new Date(record.updatedAt.getTime() - 5000).toUTCString() },
    });
    expect(stale.status).toBe(200);
  });

  it("serves a retired token the superseded rendering, lets it unregister, never register", async () => {
    const { call, record, store, built } = await setup();
    await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN } });
    const next = rotatedRecord(record, OWNER_B);
    await store.putPass(next);
    const res = await call("GET", `/v1/passes/${PASS_TYPE}/s3r1al`, { token: record.authenticationToken });
    expect(res.status).toBe(200);
    expect(built.at(-1)).toEqual({ retired: true, token: record.authenticationToken });
    const reg2 = `/v1/devices/dev2/registrations/${PASS_TYPE}/s3r1al`;
    expect((await call("POST", reg2, { token: record.authenticationToken, body: { pushToken: "b".repeat(64) } })).status).toBe(401);
    expect((await call("DELETE", regPath, { token: record.authenticationToken })).status).toBe(200);
    expect(await store.pushTokensForSerial(PASS_TYPE, "s3r1al")).toEqual([]);
  });

  it("accepts device logs unauthenticated and sanitizes them", async () => {
    const lines: string[][] = [];
    const handler = applePassKitWebService({
      store: new MemoryApplePassStore(),
      passTypeIdentifier: PASS_TYPE,
      buildPass: async () => new Uint8Array(),
      onLog: (l) => lines.push(l),
    });
    const res = await handler(
      new Request("https://issuer.example/v1/log", {
        method: "POST",
        body: JSON.stringify({ logs: ["a\nforged line", 7, "x".repeat(1000), ...Array(30).fill("y")] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(lines[0]![0]).toBe("a forged line");
    expect(lines[0]![1]).toHaveLength(300);
    expect(lines[0]!.length).toBeLessThanOrEqual(20);
  });

  it("caps pre-auth bodies: the unauthenticated log route and registration", async () => {
    const lines: string[][] = [];
    const handler = applePassKitWebService({
      store: new MemoryApplePassStore(),
      passTypeIdentifier: PASS_TYPE,
      buildPass: async () => new Uint8Array(),
      onLog: (l) => lines.push(l),
    });
    const big = JSON.stringify({ logs: ["x".repeat(MAX_LOG_BODY_BYTES)] });
    expect((await handler(new Request("https://issuer.example/v1/log", { method: "POST", body: big }))).status).toBe(413);
    // No Content-Length: the cap is enforced while streaming.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(1024).fill(0x20));
        c.close();
      },
    });
    const streamed = new Request("https://issuer.example/v1/log", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await handler(streamed)).status).toBe(413);
    expect(lines).toEqual([]);

    const { call, record } = await setup();
    const res = await call("POST", regPath, { token: record.authenticationToken, body: { pushToken: PUSH_TOKEN, pad: "y".repeat(4096) } });
    expect(res.status).toBe(413);
  });
});

describe("APNs client", () => {
  interface Seen {
    path: string;
    topic: string | undefined;
    pushType: string | undefined;
    authorization: string | undefined;
    body: string;
  }

  let server: http2.Http2Server;
  let origin: string;
  const seen: Seen[] = [];
  const GONE = "d".repeat(64);
  let ecPublicPem: string;
  let ecPrivatePem: string;

  beforeAll(async () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    ecPrivatePem = ec.privateKey;
    ecPublicPem = ec.publicKey;
    // Cleartext HTTP/2 stands in for the gateway; the request shape is identical.
    server = http2.createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (c: string) => (body += c));
      stream.on("end", () => {
        const path = String(headers[":path"]);
        seen.push({
          path,
          topic: headers["apns-topic"] as string | undefined,
          pushType: headers["apns-push-type"] as string | undefined,
          authorization: headers.authorization as string | undefined,
          body,
        });
        if (path.endsWith(GONE)) {
          stream.respond({ ":status": 410, "content-type": "application/json" });
          stream.end(JSON.stringify({ reason: "Unregistered", timestamp: Date.now() }));
        } else {
          stream.respond({ ":status": 200, "apns-id": "x" });
          stream.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("pushes an empty payload on the pass type topic with an ES256 provider token", async () => {
    seen.length = 0;
    const apns = createApnsClient({ keyId: "KEY1234567", teamId: TEAM, privateKeyP8: ecPrivatePem, origin, passTypeIdentifier: PASS_TYPE });
    const out = await apns.send(["c".repeat(64), "c".repeat(64)]);
    expect(out).toEqual([{ token: "c".repeat(64), ok: true, status: 200 }]);
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.path).toBe(`/3/device/${"c".repeat(64)}`);
    expect(s.topic).toBe(PASS_TYPE);
    expect(s.pushType).toBe("background");
    expect(s.body).toBe("{}");
    const m = /^bearer (.+)$/.exec(s.authorization ?? "");
    expect(m).not.toBeNull();
    const jwt = m![1]!;
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const { payload } = await jwtVerify(jwt, await importSPKI(ecPublicPem, "ES256"), { issuer: TEAM });
    expect(typeof payload.iat).toBe("number");

    // The token and the session are both reused across batches.
    await apns.send(["e".repeat(64)]);
    expect(seen[1]!.authorization).toBe(s.authorization);
    expect(apns.connects).toBe(1);
    apns.close();
  });

  it("drops a push token on 410 Unregistered and keeps the rest", async () => {
    const store = new MemoryApplePassStore();
    await store.register({ deviceLibraryIdentifier: "d1", passTypeIdentifier: PASS_TYPE, serial: "s", pushToken: GONE });
    await store.register({ deviceLibraryIdentifier: "d2", passTypeIdentifier: PASS_TYPE, serial: "s", pushToken: PUSH_TOKEN });
    const apns = createApnsClient({ keyId: "KEY1234567", teamId: TEAM, privateKeyP8: ecPrivatePem, origin, passTypeIdentifier: PASS_TYPE, store });
    const out = await apns.pushPassUpdate("s");
    expect(out.find((o) => o.token === GONE)).toMatchObject({ ok: false, status: 410, reason: "Unregistered" });
    expect(out.find((o) => o.token === PUSH_TOKEN)).toMatchObject({ ok: true });
    expect(await store.pushTokensForSerial(PASS_TYPE, "s")).toEqual([PUSH_TOKEN]);
    apns.close();
  });

  it("settles every token when the gateway is unreachable", async () => {
    const apns = createApnsClient({
      keyId: "K",
      teamId: TEAM,
      privateKeyP8: ecPrivatePem,
      origin: "http://127.0.0.1:1",
      passTypeIdentifier: PASS_TYPE,
      connectTimeoutMs: 2000,
    });
    const out = await apns.send([PUSH_TOKEN]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0]!.reason).toMatch(/^connect/);
  });

  it("authenticates with the pass certificate over mutual TLS", async () => {
    const tls = makeTlsIdentity();
    let clientCertCn: string | undefined;
    const secure = http2.createSecureServer({ ...tls, requestCert: true, rejectUnauthorized: false });
    secure.on("stream", (stream, headers) => {
      const peer = (stream.session?.socket as import("node:tls").TLSSocket).getPeerCertificate();
      clientCertCn = String(peer.subject?.CN);
      expect(headers["apns-topic"]).toBe(PASS_TYPE);
      expect(headers.authorization).toBeUndefined();
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
    const port = (secure.address() as AddressInfo).port;
    const apns = createApnsClient({
      certificate: { cert: certs.signerCert, key: certs.signerKey },
      origin: `https://localhost:${port}`,
      connectOptions: { ca: tls.cert },
      passTypeIdentifier: PASS_TYPE,
    });
    const out = await apns.send([PUSH_TOKEN]);
    expect(out[0]).toMatchObject({ ok: true, status: 200 });
    expect(clientCertCn).toBe("Pass Type ID: pass.example.test");
    apns.close();
    secure.close();
  });
});

describe("appleFormatProvider", () => {
  const SECRET = "s".repeat(48);

  function fakeApns(): ApnsClient & { pushed: string[] } {
    const pushed: string[] = [];
    return {
      pushed,
      connects: 0,
      close() {},
      async send(): Promise<PushOutcome[]> {
        return [];
      },
      async pushPassUpdate(serial: string): Promise<PushOutcome[]> {
        pushed.push(serial);
        return [];
      },
    };
  }

  function provider(apns = fakeApns(), extra: Partial<Parameters<typeof appleFormatProvider>[0]> = {}) {
    const p = appleFormatProvider({
      passTypeIdentifier: PASS_TYPE,
      teamIdentifier: TEAM,
      certificates: certs,
      origin: "https://issuer.example",
      linkSecret: SECRET,
      apns,
      ...extra,
    });
    return { p, apns };
  }

  it("refuses a short link secret", () => {
    expect(() =>
      appleFormatProvider({ passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs, origin: "https://x.example", linkSecret: "short" }),
    ).toThrow(/32 bytes/);
  });

  it("serves the acquisition URL as a signed pkpass with the spec media type", async () => {
    const { p } = provider();
    expect(p.format).toBe("apple");
    const url = await p.acquisitionUrl(ctx(OWNER_A));
    expect(url).toMatch(/^https:\/\/issuer\.example\/apple\/passes\/s3r1al\/[0-9a-f]{64}\.pkpass$/);
    // Repeat claim by the same owner: same URL, no rotation.
    expect(await p.acquisitionUrl(ctx(OWNER_A))).toBe(url);
    const res = await p.handle(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const pass = JSON.parse(unzip(new Uint8Array(await res.arrayBuffer()))["pass.json"]!.toString());
    const record = (await p.store.getPass("s3r1al"))!;
    expect(pass.webServiceURL).toBe("https://issuer.example/apple");
    expect(pass.authenticationToken).toBe(record.authenticationToken);
    // A guessed capability is a 404, like an unknown serial.
    expect((await p.handle(new Request(url.replace(/[0-9a-f]{64}/, "0".repeat(64))))).status).toBe(404);
  });

  it("rotates on transfer: the old URL dies, the old device refreshes into a voided pass", async () => {
    const { p, apns } = provider();
    const oldUrl = await p.acquisitionUrl(ctx(OWNER_A));
    const oldToken = (await p.store.getPass("s3r1al"))!.authenticationToken;
    const newUrl = await p.acquisitionUrl(ctx(OWNER_B));
    expect(newUrl).not.toBe(oldUrl);
    expect(apns.pushed).toEqual(["s3r1al"]);
    expect((await p.handle(new Request(oldUrl))).status).toBe(404);
    expect((await p.handle(new Request(newUrl))).status).toBe(200);

    const refresh = await p.handle(
      new Request(`https://issuer.example/apple/v1/passes/${PASS_TYPE}/s3r1al`, { headers: { authorization: `ApplePass ${oldToken}` } }),
    );
    expect(refresh.status).toBe(200);
    const pass = JSON.parse(unzip(new Uint8Array(await refresh.arrayBuffer()))["pass.json"]!.toString());
    expect(pass.voided).toBe(true);
    expect(pass.authenticationToken).toBe(oldToken);
    expect(pass.barcodes).toBeUndefined();
    expect(pass.storeCard.backFields.map((f: { key: string }) => f.key)).toEqual(["supersededNote"]);
    // The old pass says why: the token changed hands.
    expect(pass.storeCard.primaryFields[0].value).toBe("Transferred");
    expect(pass.storeCard.backFields[0].value).toMatch(/^The token moved to a new owner/);
    expect(JSON.stringify(pass)).not.toContain("issuer.example/a?");
  });

  it("rotates on the owner's request and pushes", async () => {
    const { p, apns } = provider();
    const url = await p.acquisitionUrl(ctx(OWNER_A));
    const fresh = await p.rotate("s3r1al");
    expect(fresh).not.toBe(url);
    expect((await p.handle(new Request(url))).status).toBe(404);
    expect(apns.pushed).toEqual(["s3r1al"]);
  });

  it("notifyUpdate stores the new content, bumps updatedAt and pushes", async () => {
    const { p, apns } = provider();
    await p.acquisitionUrl(ctx(OWNER_A));
    const before = (await p.store.getPass("s3r1al"))!.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await p.notifyUpdate!(ctx(OWNER_A, content({ primary: [{ key: "bal", label: "BALANCE", value: "13" }] })));
    const after = (await p.store.getPass("s3r1al"))!;
    expect(after.updatedAt.getTime()).toBeGreaterThan(before);
    expect(after.content!.primary![0]!.value).toBe("13");
    expect(apns.pushed).toEqual(["s3r1al"]);
  });

  it("implements PassFileProvider for the issuer, with no link secret needed", async () => {
    const apns = fakeApns();
    const p = appleFormatProvider({ passTypeIdentifier: PASS_TYPE, teamIdentifier: TEAM, certificates: certs, origin: "https://issuer.example", apns });
    expect(isPassFileProvider(p)).toBe(true);
    const file = await p.passFile(ctx(OWNER_A));
    expect(file.contentType).toBe(PKPASS_MEDIA_TYPE);
    expect(file.filename).toBe("pass.pkpass");
    const pass = JSON.parse(unzip(file.body as Uint8Array)["pass.json"]!.toString());
    expect(pass.authenticationToken).toBe((await p.store.getPass("s3r1al"))!.authenticationToken);
    // A new owner rotates the token and pushes the previous holder's devices.
    const oldToken = pass.authenticationToken;
    await p.passFile(ctx(OWNER_B));
    expect((await p.store.getPass("s3r1al"))!.authenticationToken).not.toBe(oldToken);
    expect(apns.pushed).toEqual(["s3r1al"]);
    await p.notifyUpdate(ctx(OWNER_B));
    expect(apns.pushed).toEqual(["s3r1al", "s3r1al"]);
    // The standalone routes need the secret.
    await expect(p.acquisitionUrl(ctx(OWNER_B))).rejects.toThrow(/linkSecret/);
    expect((await p.handle(new Request("https://issuer.example/apple/passes/s3r1al/" + "0".repeat(64) + ".pkpass"))).status).toBe(404);
  });

  const refreshWith = (p: ReturnType<typeof provider>["p"], token: string) =>
    p.handle(new Request(`https://issuer.example/apple/v1/passes/${PASS_TYPE}/s3r1al`, { headers: { authorization: `ApplePass ${token}` } }));
  const registerWith = (p: ReturnType<typeof provider>["p"], token: string) =>
    p.handle(
      new Request(`https://issuer.example/apple/v1/devices/dev9/registrations/${PASS_TYPE}/s3r1al`, {
        method: "POST",
        headers: { authorization: `ApplePass ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ pushToken: "f".repeat(64) }),
      }),
    );
  const passJsonOf = async (res: Response) => JSON.parse(unzip(new Uint8Array(await res.arrayBuffer()))["pass.json"]!.toString());

  it("a superseded serial (voided, as the issuer sends on owner rotation) cuts off a leaked copy", async () => {
    const { p, apns } = provider();
    const file = await p.passFile(ctx(OWNER_A));
    const leakedToken = JSON.parse(unzip(file.body as Uint8Array)["pass.json"]!.toString()).authenticationToken as string;

    // The issuer minted a new serial and voids this one: same owner, no links.
    await p.notifyUpdate(ctx(OWNER_A, content({ voided: true, links: [] })));
    expect(apns.pushed).toEqual(["s3r1al"]);

    const refresh = await refreshWith(p, leakedToken);
    expect(refresh.status).toBe(200);
    const pass = await passJsonOf(refresh);
    expect(pass.voided).toBe(true);
    expect(pass.barcodes).toBeUndefined();
    expect(JSON.stringify(pass)).not.toContain("https://issuer.example/a?");
    expect(pass.storeCard.backFields[0].value).toMatch(/^A newer pass replaced this one/);
    // The leaked copy can no longer attach devices.
    expect((await registerWith(p, leakedToken)).status).toBe(401);
    // A second voided notify does not rotate again.
    const token2 = (await p.store.getPass("s3r1al"))!.authenticationToken;
    await p.notifyUpdate(ctx(OWNER_A, content({ voided: true, links: [] })));
    expect((await p.store.getPass("s3r1al"))!.authenticationToken).toBe(token2);
  });

  it("rotate(serial, content) cuts off a leaked copy and gives the owner the fresh links", async () => {
    const { p, apns } = provider();
    await p.acquisitionUrl(ctx(OWNER_A));
    const leakedToken = (await p.store.getPass("s3r1al"))!.authenticationToken;
    const fresh = content({ links: [{ key: "act", label: "Do the thing", url: "https://issuer.example/fresh-link" }] });
    const url = await p.rotate("s3r1al", fresh);
    expect(url).toMatch(/\.pkpass$/);
    expect(apns.pushed).toEqual(["s3r1al"]);

    const leaked = await passJsonOf(await refreshWith(p, leakedToken));
    expect(leaked.voided).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain("fresh-link");
    // An owner reset says so, and tells a holder who still owns the token
    // where the current pass comes from.
    expect(leaked.storeCard.primaryFields[0].value).toBe("Links reset");
    expect(leaked.storeCard.backFields[0].value).toContain("The token is not affected");
    expect(leaked.storeCard.backFields[0].value).toContain("add the current pass from Example Org");
    expect((await registerWith(p, leakedToken)).status).toBe(401);

    const owners = await passJsonOf(await p.handle(new Request(url!)));
    expect(JSON.stringify(owners)).toContain("fresh-link");
    expect(owners.voided).toBeUndefined();
  });

  it("a superseded serial carrying the issuer's reason renders that reason", async () => {
    const { p } = provider();
    await p.passFile(ctx(OWNER_A));
    const token = (await p.store.getPass("s3r1al"))!.authenticationToken;
    await p.notifyUpdate(ctx(OWNER_A, content({ voided: true, links: [], supersededReason: "reset" })));
    const pass = await passJsonOf(await refreshWith(p, token));
    expect(pass.voided).toBe(true);
    expect(pass.storeCard.primaryFields[0].value).toBe("Links reset");
  });

  it("each retired token keeps the reason it was retired for", async () => {
    const { p } = provider();
    await p.acquisitionUrl(ctx(OWNER_A));
    const sellersToken = (await p.store.getPass("s3r1al"))!.authenticationToken;
    await p.acquisitionUrl(ctx(OWNER_B));
    const buyersOldToken = (await p.store.getPass("s3r1al"))!.authenticationToken;
    await p.rotate("s3r1al");
    expect((await passJsonOf(await refreshWith(p, sellersToken))).storeCard.primaryFields[0].value).toBe("Transferred");
    expect((await passJsonOf(await refreshWith(p, buyersOldToken))).storeCard.primaryFields[0].value).toBe("Links reset");
  });

  it("a record written before reasons existed renders the generic wording", async () => {
    const { p } = provider();
    await p.acquisitionUrl(ctx(OWNER_A));
    const record = (await p.store.getPass("s3r1al"))!;
    const legacyToken = "l".repeat(64);
    const { retiredReasons: _dropped, ...legacy } = { ...record, retiredAuthenticationTokens: [legacyToken] };
    await p.store.putPass(legacy);
    const pass = await passJsonOf(await refreshWith(p, legacyToken));
    expect(pass.storeCard.primaryFields[0].value).toBe("No longer current");
    expect(pass.storeCard.backFields[0].value).toMatch(/^A newer pass replaced this one/);
    // The next rotation lines the old token up with an unknown reason.
    await p.rotate("s3r1al");
    expect((await p.store.getPass("s3r1al"))!.retiredReasons).toEqual(["reset", null]);
  });

  it("a custom supersede hook receives the reason", async () => {
    const seen: Array<string | undefined> = [];
    const { p } = provider(undefined, {
      supersede: (c, reason) => {
        seen.push(reason);
        return supersededContent(c, reason);
      },
    });
    await p.acquisitionUrl(ctx(OWNER_A));
    const token = (await p.store.getPass("s3r1al"))!.authenticationToken;
    await p.acquisitionUrl(ctx(OWNER_B));
    await refreshWith(p, token);
    expect(seen).toEqual(["transfer"]);
  });

  it("omits the web service on an http origin", async () => {
    const p = appleFormatProvider({
      passTypeIdentifier: PASS_TYPE,
      teamIdentifier: TEAM,
      certificates: certs,
      origin: "http://localhost:3000",
      linkSecret: SECRET,
    });
    expect(p.webServiceURL).toBeUndefined();
    const res = await p.handle(new Request(await p.acquisitionUrl(ctx(OWNER_A))));
    const pass = JSON.parse(unzip(new Uint8Array(await res.arrayBuffer()))["pass.json"]!.toString());
    expect(pass.webServiceURL).toBeUndefined();
    expect(pass.authenticationToken).toBeUndefined();
  });
});
