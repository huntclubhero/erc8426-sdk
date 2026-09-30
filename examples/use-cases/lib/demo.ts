// SPDX-License-Identifier: MIT
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Address } from "viem";
import { createWalletPassClient, type WalletPassClient, type WalletPassSigner } from "@erc8426/client";
import type { PassContent } from "@erc8426/core";
import { ActionError, type Issuer } from "@erc8426/issuer";

import { startAnvil, type Anvil } from "./anvil.js";
import { connect, revertName, type Chain8426, type ChainIndexer } from "./chain.js";
import { downloadPreview } from "./preview.js";
import { note } from "./narrate.js";

/// Everything a demo needs: a fresh chain, a client, and cleanup.
export interface Stage {
  anvil: Anvil;
  chain: Chain8426;
  client: WalletPassClient;
  /// Route receipts' Transfer / PassUpdate / BatchPassUpdate for `contract`
  ///  to `issuer`, the way an indexer webhook would.
  index(contract: Address, issuer: Issuer, onLog?: ChainIndexer["onLog"]): void;
  close(): Promise<void>;
}

export async function stage(): Promise<Stage> {
  const anvil = await startAnvil();
  const chain = connect(anvil.rpcUrl);
  const client = createWalletPassClient({ publicClient: chain.publicClient });
  const routes = new Map<string, { issuer: Issuer; onLog?: ChainIndexer["onLog"] }>();
  chain.setIndexer({
    async onTransfer(contract, tokenId, from, to) {
      const r = routes.get(contract.toLowerCase());
      if (!r) return;
      const rotated = await r.issuer.onTransfer(tokenId, from, to);
      note(`indexer: Transfer of #${tokenId} seen${rotated ? ", issuer rotated every link and download URL" : ""}`);
    },
    async onPassUpdate(contract, from, to) {
      const r = routes.get(contract.toLowerCase());
      if (!r) return;
      const { updated } = await r.issuer.onPassUpdate(from, to);
      const range = from === to ? `#${from}` : `#${from}..#${to}`;
      note(`indexer: ${from === to ? "PassUpdate" : "BatchPassUpdate"} ${range}, ${updated} issued pass(es) refreshed`);
    },
    async onLog(contract, eventName, args) {
      const r = routes.get(contract.toLowerCase());
      if (r?.onLog) await r.onLog(contract, eventName, args);
    },
  });
  return {
    anvil,
    chain,
    client,
    index(contract, issuer, onLog) {
      routes.set(contract.toLowerCase(), onLog ? { issuer, onLog } : { issuer });
    },
    async close() {
      anvil.stop();
    },
  };
}

/// Resolve the gated manifest as `signer` and download the preview pass: what
///  "Add to Wallet" does on a phone.
export async function installPass(
  client: WalletPassClient,
  token: { contract: Address; tokenId: bigint },
  signer: WalletPassSigner,
): Promise<{ content: PassContent; manifest: Record<string, string>; downloadUrl: string }> {
  const { manifest } = await client.getManifest(token, { signer });
  const downloadUrl = manifest.formats.preview;
  if (!downloadUrl) throw new Error("manifest has no preview format");
  return { content: await downloadPreview(downloadUrl), manifest: manifest.formats, downloadUrl };
}

/// Find a link on an installed pass by key.
export function linkOf(content: PassContent, key: string): string {
  const link = content.links?.find((l) => l.key === key);
  if (!link) throw new Error(`pass has no ${key} link`);
  return link.url;
}

/// What a tap on a capability link does: the device GETs it (side-effect
///  free, it only describes the action), the holder confirms, the confirm
///  page POSTs it.
export async function describeLink(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export class LinkRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`${status} ${String(body.error)}${body.message ? `: ${String(body.message)}` : ""}`);
  }
}

export async function tapLink(url: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(params !== undefined ? { params } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new LinkRefused(res.status, body);
  return body;
}

/// Run an operator transaction inside an action's `execute`, turning the
///  contract's refusal into an issuer ActionError with a readable code, so
///  the chain's bound surfaces to the caller as a 409 or 429.
export async function onChain<T>(fn: () => Promise<T>, map: Record<string, [number, string]> = {}): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const name = revertName(e);
    if (!name) throw e;
    const [status, message] = map[name] ?? [409, "the contract refused the call"];
    throw new ActionError(status, name, message);
  }
}

export function fmtTime(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function fmtUsd(units: bigint): string {
  const cents = units / 10_000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/// Run `main` when the file is executed directly (tsx pet-game/demo.ts), not
///  when it is imported by run-all.ts.
export function runIfMain(moduleUrl: string, main: () => Promise<void>): void {
  const entry = process.argv[1];
  if (!entry || pathToFileURL(resolve(entry)).href !== moduleUrl) return;
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
