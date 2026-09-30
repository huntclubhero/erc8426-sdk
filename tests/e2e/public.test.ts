import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Abi, Address } from "viem";
import { GOOGLE_SAVE_URL_PREFIX, PKPASS_MEDIA_TYPE } from "@erc8426/core";
import { createWalletPassClient } from "@erc8426/client";
import { formatReport, runConformance } from "@erc8426/conformance";
import { IssuerConfigError, createIssuer, type Issuer } from "@erc8426/issuer";

import { appleProvider, deploy, googleProvider, newActor, send, startAnvil, startServer, type Actor, type Chain, type HttpServer } from "./harness.js";

let chain: Chain;
let server: HttpServer;
let issuer: Issuer;
let petPass: { address: Address; abi: Abi };
let deployer: Actor, owner: Actor, buyer: Actor;

beforeAll(async () => {
  chain = await startAnvil();
  [deployer, owner, buyer] = await Promise.all([newActor(chain), newActor(chain), newActor(chain)]);
  server = await startServer();
  petPass = await deploy(chain, deployer, "PetPass", [`${server.baseUrl}/wallet-pass/`, deployer.address, 86_400n * 3n]);
  await send(chain, deployer, petPass.address, petPass.abi, "mint", [owner.address]);
  issuer = createIssuer({
    domain: server.domain,
    baseUrl: server.baseUrl,
    chainId: chain.publicClient.chain!.id,
    contract: petPass.address,
    mode: "public",
    publicClient: chain.publicClient,
    providers: [appleProvider(server.baseUrl), googleProvider(server.baseUrl).provider],
    render: ({ token, serial }) => ({ serial, organizationName: "Pet Pass", description: `Pet #${token.tokenId}`, title: "Pet" }),
  });
  server.setHandler((r) => issuer.handler(r));
}, 120_000);

afterAll(async () => {
  await server?.close();
  await chain?.stop();
});

describe("public configuration", () => {
  it("passes every MUST check without an owner key", async () => {
    const report = await runConformance({ publicClient: chain.publicClient, contract: petPass.address, tokenId: 1n });
    if (!report.ok) console.error(formatReport(report));
    expect(report.configuration).toBe("public");
    expect(report.summary.fail).toBe(0);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("serves the manifest to anyone; the client learns the configuration from the response", async () => {
    const client = createWalletPassClient({ publicClient: chain.publicClient });
    const res = await client.getManifest({ contract: petPass.address, tokenId: 1n });
    expect(res.configuration).toBe("public");
    expect(res.manifest.formats.google!.startsWith(GOOGLE_SAVE_URL_PREFIX)).toBe(true);
    const head = await fetch(res.manifest.formats.apple!, { method: "HEAD" });
    expect(head.headers.get("content-type")).toBe(PKPASS_MEDIA_TYPE);
  });

  it("rotates acquisition URLs when a transfer is observed on the next fetch", async () => {
    const client = createWalletPassClient({ publicClient: chain.publicClient });
    const before = await client.getManifest({ contract: petPass.address, tokenId: 1n });
    await send(chain, owner, petPass.address, petPass.abi, "transferFrom", [owner.address, buyer.address, 1n]);
    const after = await client.getManifest({ contract: petPass.address, tokenId: 1n });
    expect(after.manifest.formats.apple).not.toBe(before.manifest.formats.apple);
    expect((await fetch(before.manifest.formats.apple!, { method: "HEAD" })).status).toBe(404);
  });

  it("has no capability configuration: enabling it here is a config error", () => {
    expect(() =>
      createIssuer({
        domain: server.domain,
        baseUrl: server.baseUrl,
        chainId: 31337,
        contract: petPass.address,
        mode: "public",
        publicClient: chain.publicClient,
        providers: [appleProvider(server.baseUrl)],
        render: ({ serial }) => ({ serial, organizationName: "o", description: "d", title: "t" }),
        capability: { enabled: true },
      }),
    ).toThrowError(IssuerConfigError);
  });
});
