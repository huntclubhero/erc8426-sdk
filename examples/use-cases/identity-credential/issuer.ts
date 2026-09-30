// SPDX-License-Identifier: MIT
import type { Address, Hex } from "viem";
import type { PassContent, PassDeliveryProvider } from "@erc8426/core";
import { createIssuer, type Issuer } from "@erc8426/issuer";

import { artifact, type Chain8426 } from "../lib/chain.js";
import { fmtTime } from "../lib/demo.js";

const idc = artifact("IdentityCredential");

export interface Credential {
  claimHash: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
  attester: Address;
}

export async function readCredential(chain: Chain8426, contract: Address, tokenId: bigint) {
  const [c, valid] = await Promise.all([
    chain.read<Credential>(contract, idc.abi, "credential", [tokenId]),
    chain.read<boolean>(contract, idc.abi, "isValid", [tokenId]),
  ]);
  return { ...c, valid };
}

export interface CredentialIssuerOptions {
  baseUrl: string;
  domain: string;
  contract: Address;
  chain: Chain8426;
  providers: PassDeliveryProvider[];
  /// What the credential attests, shown on the card. Never personal data:
  ///  the chain holds only a hash of the claim.
  claimLabel: string;
}

/// A soulbound ID card. The pass is a bearer artifact, so a copy of it proves
///  nothing: a verifier asks the holder to sign a single-use `verify`
///  challenge, and the issuer runs the two checks (the signature and a fresh
///  ownerOf read) before reporting the credential's status. There are no
///  capability links: nothing about an identity check can be delegated to
///  whoever holds a URL.
export function createCredentialIssuer(o: CredentialIssuerOptions): Issuer {
  return createIssuer({
    domain: o.domain,
    baseUrl: o.baseUrl,
    chainId: o.chain.publicClient.chain.id,
    contract: o.contract,
    mode: "gated",
    publicClient: o.chain.publicClient,
    providers: o.providers,
    actions: {
      verify: {
        description: "Prove to a verifier that you hold this credential",
        execute: async ({ token, account }) => {
          const c = await readCredential(o.chain, o.contract, BigInt(token.tokenId));
          return {
            valid: c.valid,
            status: c.revoked ? "revoked" : c.valid ? "valid" : "expired",
            claim: o.claimLabel,
            claimHash: c.claimHash,
            expiresAt: Number(c.expiresAt),
            holder: account,
            attester: c.attester,
          };
        },
      },
    },
    async render({ token, serial }): Promise<PassContent> {
      const id = BigInt(token.tokenId);
      const c = await readCredential(o.chain, o.contract, id);
      const status = c.revoked ? "REVOKED" : c.valid ? "Valid" : "Expired";
      return {
        serial,
        style: "generic",
        organizationName: "Credential Authority",
        description: `Credential #${id}`,
        title: "ID CARD",
        colors: c.revoked ? { background: "#5C1111", foreground: "#FFE3E3" } : { background: "#0F2E4D", foreground: "#EAF2FB", label: "#8FC1F2" },
        primary: [{ key: "claim", label: "Attests", value: o.claimLabel }],
        secondary: [
          { key: "status", label: "Status", value: status, changeMessage: "Credential %@" },
          { key: "expires", label: "Expires", value: fmtTime(c.expiresAt) },
        ],
        auxiliary: [{ key: "issued", label: "Issued", value: fmtTime(c.issuedAt) }],
        back: [
          { key: "verify", label: "Verification", value: "Verifiers ask you to sign a one-time challenge. A copy of this card proves nothing." },
          { key: "rotate", label: "Lost your phone?", value: "Request rotation: every link and download for this card changes." },
        ],
        // A revoked credential presents as void on the device.
        ...(c.revoked ? { voided: true } : {}),
        expiresAt: new Date(Number(c.expiresAt) * 1000),
      };
    },
  });
}
