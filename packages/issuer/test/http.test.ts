import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { expressMiddleware, normalizeOrigin, toNodeHandler } from "@erc8426/issuer";

import { TOKEN_ID, buildHarness, newSigner, proof, signChallenge, type Harness } from "./helpers.js";

const MANIFEST = `/wallet-pass/${TOKEN_ID}`;

describe("CORS", () => {
  it("sends no Access-Control headers at all when cors is not configured", async () => {
    const h = buildHarness();
    const res = await h.get(MANIFEST, { Origin: "https://wallet.example" });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-expose-headers")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    const preflight = await h.issuer.handler(
      new Request(`https://issuer.example${MANIFEST}`, {
        method: "OPTIONS",
        headers: { Origin: "https://wallet.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-wallet-pass-proof" },
      }),
    );
    expect(preflight.status).toBe(204);
    const names: string[] = [];
    preflight.headers.forEach((_v, k) => names.push(k));
    expect(names.filter((k) => k.startsWith("access-control"))).toEqual([]);
  });

  it("answers a preflight admitting the two proof headers when a wildcard is set explicitly", async () => {
    const h = buildHarness({ cors: { origins: "*" } });
    const res = await h.issuer.handler(
      new Request(`https://issuer.example${MANIFEST}`, {
        method: "OPTIONS",
        headers: { Origin: "https://wallet.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-wallet-pass-proof" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowed = res.headers.get("access-control-allow-headers")!.toLowerCase();
    expect(allowed).toContain("x-wallet-pass-proof");
    expect(allowed).toContain("x-wallet-pass-signature");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("lets a browser read the 401 challenge and the Retry-After of a 503 under an explicit wildcard", async () => {
    const h = buildHarness({ cors: { origins: "*" } });
    const res = await h.get(MANIFEST, { Origin: "https://wallet.example" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("echoes only allowlisted origins", async () => {
    const h = buildHarness({ cors: { origins: ["https://app.example"] } });
    const ok = await h.get(MANIFEST, { Origin: "https://app.example" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("vary")).toContain("Origin");
    const other = await h.get(MANIFEST, { Origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    // Never a wildcard from a list, and nothing without an Origin header.
    expect(ok.headers.get("access-control-allow-origin")).not.toBe("*");
    // A browser may read the repeat marker and Retry-After.
    expect(ok.headers.get("access-control-expose-headers")).toContain("X-Wallet-Pass-Repeat");
    expect(ok.headers.get("access-control-expose-headers")).toContain("Retry-After");
    expect((await h.get(MANIFEST)).headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await h.issuer.handler(
      new Request(`https://issuer.example${MANIFEST}`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("compares origins after normalization: case, default port and trailing form do not split an origin", async () => {
    const h = buildHarness({ cors: { origins: ["HTTPS://App.Example:443", "http://Dev.Local:8080"] } });
    expect(h.issuer.config.cors && h.issuer.config.cors.origins).toEqual(["https://app.example", "http://dev.local:8080"]);
    for (const origin of ["https://app.example", "https://APP.example", "https://app.example:443", "http://dev.local:8080", "HTTP://DEV.LOCAL:8080"]) {
      const res = await h.get(MANIFEST, { Origin: origin });
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
    for (const origin of ["https://app.example:8443", "http://app.example", "https://dev.local:8080", "null", "not an origin"]) {
      expect((await h.get(MANIFEST, { Origin: origin })).headers.get("access-control-allow-origin"), origin).toBeNull();
    }
    expect(normalizeOrigin("https://App.Example:443")).toBe("https://app.example");
    expect(normalizeOrigin("https://app.example/path")).toBeNull();
    expect(normalizeOrigin("app.example")).toBeNull();
  });

  it("can be switched off", async () => {
    const h = buildHarness({ cors: false });
    expect((await h.get(MANIFEST, { Origin: "https://app.example" })).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("basePath", () => {
  it("serves the surface under a custom basePath", async () => {
    const h = buildHarness({ basePath: "/api/pass" });
    const res = await h.get(`/api/pass/${TOKEN_ID}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { challenge: string }).challenge).toBe(`https://issuer.example/api/pass/${TOKEN_ID}/challenge`);
    expect(await h.issuer.route(new Request(`https://issuer.example/wallet-pass/${TOKEN_ID}`))).toBeNull();
  });

  it("builds absolute URLs from baseUrl, never from the request Host", async () => {
    const h = buildHarness();
    const res = await h.issuer.handler(new Request(`http://attacker.example${MANIFEST}`));
    expect(((await res.json()) as { challenge: string }).challenge.startsWith("https://issuer.example/")).toBe(true);
  });
});

describe("Node adapter", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function listen(listener: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(listener);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  async function roundTrip(h: Harness, origin: string) {
    const owner = newSigner();
    h.chain.setOwner(TOKEN_ID, owner.address);
    const refused = await fetch(`${origin}${MANIFEST}`);
    expect(refused.status).toBe(401);
    const challengeUrl = new URL(((await refused.json()) as { challenge: string }).challenge);
    const c = await fetch(`${origin}${challengeUrl.pathname}?address=${owner.address}`);
    const { message } = (await c.json()) as { message: string };
    const signature = await owner.signMessage({ message });
    const res = await fetch(`${origin}${MANIFEST}`, { headers: proof({ message, signature }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const action = await signChallenge(h, owner, TOKEN_ID, "levelUp");
    const posted = await fetch(`${origin}${MANIFEST}/actions/levelUp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { executed: boolean }).executed).toBe(true);
  }

  it("serves the full gated round trip over http.createServer", async () => {
    const h = buildHarness();
    const origin = await listen(toNodeHandler(h.issuer) as never);
    await roundTrip(h, origin);
  });

  it("works as Express middleware behind express.json(), falling through for other paths", async () => {
    const h = buildHarness();
    const app = express();
    app.use(express.json());
    app.use(expressMiddleware(h.issuer) as never);
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    const origin = await listen(app);
    await roundTrip(h, origin);
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ ok: true });
  });

  it("works as Express middleware without a body parser", async () => {
    const h = buildHarness();
    const app = express();
    app.use(expressMiddleware(h.issuer) as never);
    await roundTrip(h, await listen(app));
  });
});
