import { describe, expect, it } from "vitest";
import { IssuerConfigError, createIssuer, resolveConfig, type CreateIssuerOptions, type IssuerConfig } from "@erc8426/issuer";

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
    expect(c.cors).toEqual({ origins: "*", maxAgeSeconds: 600 });
    expect(c.capabilityActions).toEqual([]);
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
