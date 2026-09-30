// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatHex, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, serializeErc6492Signature, toHex, type Abi, type Address, type Hex } from "viem";
import type { PassContext, PassFileProvider } from "@erc8426/core";
import { createWalletPassClient, WalletPassClientError, type WalletPassSigner } from "@erc8426/client";
import { createIssuer, publicClientSignatureVerifier, type Issuer } from "@erc8426/issuer";

import { artifact, deploy, newActor, send, startAnvil, startServer, type Actor, type Chain, type HttpServer } from "./harness.js";

/// ERC-8426 with a contract-account owner. Email-onboarded holders usually
///  own tokens through smart accounts, so check (1) must accept an ERC-1271
///  signature: the issuer verifies through viem `verifyMessage`, which calls
///  the account's `isValidSignature` (and handles ERC-6492 for accounts not
///  deployed yet). The claimed account named in the challenge is the smart
///  account; the inner EOA only signs.

const DAY = 86_400;
/// The deterministic CREATE2 deployer anvil predeploys (Arachnid's proxy):
///  calldata is salt followed by init code.
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

let chain: Chain;
let server: HttpServer;
let issuer: Issuer;
let petPass: { address: Address; abi: Abi };
let account: { address: Address; abi: Abi };
let deployer: Actor, operator: Actor, inner: Actor, stranger: Actor;
let client: ReturnType<typeof createWalletPassClient>;

/// A signer that claims the smart account's address and signs with the
///  inner EOA: what an embedded wallet in front of a smart account does.
function accountSigner(address: Address, eoa: Actor, wrap: (signature: Hex) => Hex = (s) => s): WalletPassSigner {
  return { address, signMessage: async ({ message }) => wrap(await eoa.account.signMessage({ message })) };
}

const token = (tokenId: bigint) => ({ contract: petPass.address, tokenId });
const ownerOf = (tokenId: bigint) => chain.publicClient.readContract({ ...petPass, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>;
const cares = async (tokenId: bigint) =>
  ((await chain.publicClient.readContract({ ...petPass, functionName: "pet", args: [tokenId] })) as { cares: number }).cares;

async function refusal(p: Promise<unknown>): Promise<WalletPassClientError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletPassClientError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

/// A minimal file provider: the manifest needs at least one format, and
///  platform credentials are beside the point here.
const preview: PassFileProvider = {
  format: "preview",
  async passFile(ctx: PassContext) {
    return { body: JSON.stringify(ctx.content), contentType: "application/json" };
  },
};

beforeAll(async () => {
  chain = await startAnvil();
  [deployer, operator, inner, stranger] = await Promise.all([newActor(chain), newActor(chain), newActor(chain), newActor(chain)]);
  server = await startServer();
  petPass = await deploy(chain, deployer, "PetPass", [`${server.baseUrl}/wallet-pass/`, deployer.address, BigInt(3 * DAY)]);
  const deployed = await deploy(chain, deployer, "MockSmartAccount", [inner.address]);
  account = { ...deployed, address: getAddress(deployed.address) };
  await send(chain, deployer, petPass.address, petPass.abi, "setActionOperator", [operator.address, true]);

  // Pet #1 goes to the EOA, which moves it into its smart account with a
  // safe transfer (the account implements onERC721Received).
  await send(chain, deployer, petPass.address, petPass.abi, "mint", [inner.address]);
  await send(chain, inner, petPass.address, petPass.abi, "safeTransferFrom", [inner.address, account.address, 1n]);

  issuer = createIssuer({
    domain: server.domain,
    baseUrl: server.baseUrl,
    chainId: chain.publicClient.chain!.id,
    contract: petPass.address,
    mode: "gated",
    publicClient: chain.publicClient,
    // Explicit, to make the ERC-1271 / ERC-6492 path the one under test.
    verifier: publicClientSignatureVerifier(chain.publicClient),
    providers: [preview],
    render: ({ serial, token: t }) => ({ serial, organizationName: "Pets", description: `Pet #${t.tokenId}`, title: `Pet #${t.tokenId}` }),
    actions: {
      feed: {
        description: "Feed the pet",
        execute: async ({ token: t, account: who }) => {
          const receipt = await send(chain, operator, petPass.address, petPass.abi, "feed", [BigInt(t.tokenId)]);
          return { tx: receipt.transactionHash, account: who };
        },
      },
    },
  });
  server.setHandler(issuer.handler);
  client = createWalletPassClient({ publicClient: chain.publicClient });
});

afterAll(async () => {
  await server?.close();
  await chain?.stop();
});

describe("ERC-1271 smart account owner", () => {
  it("the smart account owns the pet", async () => {
    expect(await ownerOf(1n)).toBe(account.address);
  });

  it("resolves the gated manifest with the inner EOA signing for the account", async () => {
    const { manifest, configuration } = await client.getManifest(token(1n), { signer: accountSigner(account.address, inner) });
    expect(configuration).toBe("gated");
    expect(Object.keys(manifest.formats)).toEqual(["preview"]);
    const pass = await fetch(manifest.formats.preview!);
    expect(pass.status).toBe(200);
  });

  it("refuses another EOA signing for the account as signature_invalid (401), not 403", async () => {
    const e = await refusal(client.getManifest(token(1n), { signer: accountSigner(account.address, stranger) }));
    expect(e.status).toBe(401);
    expect(e.code).toBe("signature_invalid");
  });

  it("refuses the inner EOA claiming its own address: it is not the owner (403)", async () => {
    const e = await refusal(client.getManifest(token(1n), { signer: inner.account }));
    expect(e.status).toBe(403);
    expect(e.code).toBe("not_owner");
  });

  it("runs a signed action for the smart account on chain", async () => {
    const before = await cares(1n);
    const { status, body } = await client.signedAction({ token: token(1n), action: "feed", signer: accountSigner(account.address, inner) });
    expect(status).toBe(200);
    const b = body as { account: string; via: string; result: { tx: Hex } };
    expect(b.account).toBe(account.address);
    expect(b.via).toBe("owner");
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: b.result.tx });
    expect(receipt.status).toBe("success");
    expect(await cares(1n)).toBe(before + 1);
  });

  it("refuses a signed action signed by another EOA for the account", async () => {
    const e = await refusal(client.signedAction({ token: token(1n), action: "feed", signer: accountSigner(account.address, stranger) }));
    expect(e.status).toBe(401);
    expect(e.code).toBe("signature_invalid");
  });

  it("rotates links on the smart account's signed request", async () => {
    const { status } = await client.rotatePassLinks(token(1n), { signer: accountSigner(account.address, inner) });
    expect(status).toBe(200);
  });

  it("follows the pet when the account moves it: the account's proof stops working", async () => {
    await send(chain, deployer, petPass.address, petPass.abi, "mint", [account.address]);
    await client.getManifest(token(2n), { signer: accountSigner(account.address, inner) });
    // The inner EOA makes the account transfer pet #2 away.
    const data = encodeFunctionData({
      abi: petPass.abi,
      functionName: "transferFrom",
      args: [account.address, stranger.address, 2n],
    });
    await send(chain, inner, account.address, account.abi, "execute", [petPass.address, 0n, data]);
    expect(await ownerOf(2n)).toBe(stranger.address);
    const e = await refusal(client.getManifest(token(2n), { signer: accountSigner(account.address, inner) }));
    expect(e.status).toBe(403);
    expect(e.code).toBe("not_owner");
  });
});

describe("ERC-6492 counterfactual smart account", () => {
  it("accepts a signature from an account that is not deployed yet", async () => {
    // A MockSmartAccount for a fresh signer, deployable later through the
    // CREATE2 deployer. Its address is known before any code exists.
    const later = await newActor(chain);
    const initCode = encodeDeployData({ ...artifact("MockSmartAccount"), args: [later.address] });
    const salt = keccak256(toHex("erc8426-e2e-counterfactual"));
    const counterfactual = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode });
    expect(await chain.publicClient.getCode({ address: counterfactual })).toBeUndefined();

    await send(chain, deployer, petPass.address, petPass.abi, "mint", [counterfactual]);
    const tokenId = 3n;
    expect(await ownerOf(tokenId)).toBe(counterfactual);

    // ERC-6492: wrap the inner signature with the factory call that would
    // deploy the account; the verifier simulates the deployment.
    const wrap = (signature: Hex) =>
      serializeErc6492Signature({ address: CREATE2_DEPLOYER, data: concatHex([salt, initCode]), signature });
    const { manifest } = await client.getManifest(token(tokenId), { signer: accountSigner(counterfactual, later, wrap) });
    expect(manifest.formats.preview).toBeTruthy();
    // Still undeployed: verification did not need an on-chain deployment.
    expect(await chain.publicClient.getCode({ address: counterfactual })).toBeUndefined();

    const e = await refusal(client.getManifest(token(tokenId), { signer: accountSigner(counterfactual, stranger, wrap) }));
    expect(e.code).toBe("signature_invalid");
  });
});
