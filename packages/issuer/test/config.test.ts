import { afterEach, describe, expect, it, vi } from "vitest";
import { IssuerConfigError, createIssuer, isProductionEnv, memoryStores, resolveConfig, type CreateIssuerOptions, type IssuerConfig } from "@erc8426/issuer";

import { CONTRACT, FakeChain, fakeProviders } from "./helpers.js";

const base: IssuerConfig = { domain: "issuer.example", baseUrl: "https://issuer.example/", chainId: 1, contract: CONTRACT, mode: "gated" };
const noop = { description: "Do it", execute: () => null };

function refuses(config: Partial<IssuerConfig>, pattern: RegExp) {
  expect(() => resolveConfig({ ...base, ...config })).toThrowError(IssuerConfigError);
  expect(() => resolveConfig({ ...base, ...config })).toThrowError(pattern);
}

describe("config validation", () => {
  it("fills the defaults", () => {
    const c = resolveConfig(base);
    expect(c.baseUrl).toBe("https://issuer.example");
    expect(c.basePath).toBe("/wallet-pass");
    expect(c.uri).toBe("https://issuer.example/wallet-pass/actions");
    expect(c.challengeTtlSeconds).toBe(300);
    expect(c.nonceTtlSeconds).toBe(600);
    expect(c.retryAfterSeconds).toBe(5);
    expect(c.cors).toBe(false);
    expect(c.capabilityActions).toEqual([]);
  });

  it("sends no CORS headers unless cors is set, and a wildcard only when written explicitly", () => {
    expect(resolveConfig(base).cors).toBe(false);
    expect(resolveConfig({ ...base, cors: false }).cors).toBe(false);
    expect(resolveConfig({ ...base, cors: { origins: "*" } }).cors).toEqual({ origins: "*", maxAgeSeconds: 600 });
    expect(resolveConfig({ ...base, cors: { origins: ["https://app.example"], maxAgeSeconds: 60 } }).cors).toEqual({ origins: ["https://app.example"], maxAgeSeconds: 60 });
    refuses({ cors: { origins: "https://app.example" as unknown as "*" } }, /must be "\*" or an array/);
    refuses({ cors: { origins: ["https://app.example/path"] } }, /no path/);
    refuses({ cors: { origins: ["app.example"] } }, /scheme/);
  });

  it("refuses the capability configuration outside the gated configuration", () => {
    refuses({ mode: "public", capability: { enabled: true } }, /requires mode "gated"/);
  });

  it("refuses a capability action with no documented bound", () => {
    refuses({ capability: { enabled: true }, actions: { feed: { ...noop, capability: true } } }, /documented bound/);
  });

  it("refuses a capability action that transfers, burns or approves", () => {
    refuses(
      { capability: { enabled: true }, actions: { sell: { ...noop, capability: true, bound: "one sale", transfersOrBurns: true } } },
      /MUST NOT be reachable through a capability link/,
    );
  });

  it("allows an action that transfers on the signed path", () => {
    expect(resolveConfig({ ...base, actions: { sell: { ...noop, transfersOrBurns: true } } }).actions.sell).toBeDefined();
  });

  it("refuses a capability action when capability is not enabled", () => {
    refuses({ actions: { feed: { ...noop, capability: true, bound: "b" } } }, /capability.enabled is not set/);
  });

  it("refuses the reserved action names acquire and rotate", () => {
    refuses({ actions: { acquire: noop } }, /reserved/);
    refuses({ actions: { rotate: noop } }, /reserved/);
  });

  it("refuses an action name that cannot live in an action URN", () => {
    refuses({ actions: { "feed me": noop } }, /not valid/);
  });

  it("refuses an action without execute or description", () => {
    refuses({ actions: { feed: { description: "x" } as never } }, /execute/);
    refuses({ actions: { feed: { description: "", execute: () => null } } }, /description/);
  });

  it("refuses a domain with a scheme or path", () => {
    refuses({ domain: "https://issuer.example" }, /bare authority/);
    refuses({ domain: "issuer.example/x" }, /bare authority/);
    expect(resolveConfig({ ...base, domain: "localhost:8787", baseUrl: "http://localhost:8787" }).domain).toBe("localhost:8787");
  });

  it("refuses a domain that is not baseUrl's host, since clients will not sign it", () => {
    refuses({ domain: "other.example" }, /must match baseUrl/);
  });

  it("refuses a bad baseUrl, chainId, contract or mode", () => {
    refuses({ baseUrl: "issuer.example" }, /baseUrl/);
    refuses({ chainId: 0 }, /chainId/);
    refuses({ contract: "0x1234" }, /contract/);
    refuses({ mode: "open" as never }, /mode/);
  });

  it("refuses a nonce retention shorter than the challenge lifetime", () => {
    refuses({ challengeTtlSeconds: 300, nonceTtlSeconds: 60 }, /nonceTtlSeconds/);
  });

  it("normalizes basePath", () => {
    expect(resolveConfig({ ...base, basePath: "/api/pass/" }).basePath).toBe("/api/pass");
    expect(resolveConfig({ ...base, basePath: "/" }).basePath).toBe("");
    refuses({ basePath: "api" }, /basePath/);
  });
});

describe("createIssuer validation", () => {
  const opts = (): CreateIssuerOptions => ({ ...base, chain: new FakeChain(), providers: fakeProviders([]), render: (c) => ({ serial: c.serial, organizationName: "o", description: "d", title: "t" }) });

  it("requires at least one provider, because a manifest MUST contain at least one format", () => {
    expect(() => createIssuer({ ...opts(), providers: [] })).toThrowError(/at least one/);
  });

  it("refuses two providers for one format", () => {
    const [google] = fakeProviders([]);
    expect(() => createIssuer({ ...opts(), providers: [google!, google!] })).toThrowError(/two providers/);
  });

  it("requires a chain reader, because check (2) is never substitutable", () => {
    expect(() => createIssuer({ ...opts(), chain: undefined })).toThrowError(/chain reader/);
  });

  it("requires render", () => {
    expect(() => createIssuer({ ...opts(), render: undefined as never })).toThrowError(/render/);
  });
});

describe("stores at startup", () => {
  const minimal = (): CreateIssuerOptions => ({
    ...base,
    chain: new FakeChain(),
    providers: fakeProviders([]),
    render: () => ({ serial: "s", organizationName: "o", description: "d", title: "t" }),
  });
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  it("refuses the in-memory fallback under NODE_ENV=production, naming the missing stores", () => {
    process.env.NODE_ENV = "production";
    expect(isProductionEnv()).toBe(true);
    expect(() => createIssuer(minimal())).toThrowError(IssuerConfigError);
    expect(() => createIssuer(minimal())).toThrowError(/nonces, passes, links stores were configured/);
    expect(() => createIssuer(minimal())).toThrowError(/kvStores/);
    // One store named, two still missing: the message names the two.
    expect(() => createIssuer({ ...minimal(), stores: { nonces: memoryStores().nonces } })).toThrowError(/no passes, links stores/);
  });

  it("accepts explicit stores in production, including a deliberate memoryStores()", () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => createIssuer({ ...minimal(), stores: memoryStores() })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("outside production falls back to the in-memory stores with one warning naming them", () => {
    process.env.NODE_ENV = "test";
    expect(isProductionEnv()).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const issuer = createIssuer(minimal());
    expect(issuer.stores.nonces).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/no nonces, passes, links stores configured/);
    expect(String(warn.mock.calls[0]![0])).toMatch(/in-memory/);
    // A partial configuration warns only about what is missing, through onWarning when given.
    const messages: string[] = [];
    createIssuer({ ...minimal(), stores: { nonces: memoryStores().nonces, passes: memoryStores().passes }, onWarning: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/no links store configured/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("with NODE_ENV unset the fallback is allowed and warned about", () => {
    delete process.env.NODE_ENV;
    const messages: string[] = [];
    expect(() => createIssuer({ ...minimal(), onWarning: (m) => messages.push(m) })).not.toThrow();
    expect(messages).toHaveLength(1);
  });

  it("stays silent when every store is given", () => {
    process.env.NODE_ENV = "test";
    const messages: string[] = [];
    createIssuer({ ...minimal(), stores: memoryStores(), onWarning: (m) => messages.push(m) });
    expect(messages).toEqual([]);
  });
});
