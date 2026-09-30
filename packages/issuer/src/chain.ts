import { BaseError, ContractFunctionRevertedError, getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { erc4907Abi, erc721Abi, type TokenRef } from "@erc8426/core";

/// Fresh chain reads for check (2).
///
///  The standard requires "a fresh on-chain read of ownership ... at the time
///  of the request, not at pass issuance and not at URL minting". Keeping the
///  reads behind this interface keeps the authorization logic honest (it can
///  only ever ask for the state now) and lets tests flip the answer between
///  challenge and action.
///
///  The contract every method follows: return an answer (including "no
///  owner") when the chain gave one, and THROW when no answer could be
///  obtained. The issuer turns a throw into 503 read_failed with Retry-After,
///  never into 403, because a failed read says nothing about the account.
export interface ChainReader {
  /// The current owner, or null when the token has none (never minted or
  ///  burned: `ownerOf` reverted or returned the zero address).
  ownerOf(token: TokenRef): Promise<Address | null>;
  /// ERC-4907 rental state. `user` is null when there is no user. Needed only
  ///  by the `rental4907` policy.
  userOf?(token: TokenRef): Promise<{ user: Address | null; expires: bigint }>;
  /// delegate.xyz v2 `checkDelegateForERC721`. Needed only by the
  ///  `delegateRegistry` policy.
  checkDelegateForERC721?(input: {
    registry: Address;
    to: Address;
    from: Address;
    token: TokenRef;
    rights: Hex;
  }): Promise<boolean>;
}

/// Which block the reads are taken against.
///
///  The spec says implementations SHOULD read "against their best view of the
///  latest safe chain head". "safe" protects against a reorganization undoing
///  the transfer a read relied on, at the cost of a lag (minutes on L1)
///  during which a buyer is not yet seen as owner and a seller still is.
///  "latest" makes that window as small as the node allows and is the
///  default here because most issuers serve L2s whose safe head trails by
///  long intervals; choose "safe" when a reorg would cost more than the lag.
export type ReadBlockTag = "latest" | "safe" | "finalized";

/// The part of a viem PublicClient the reader uses. Typed structurally so
///  any chain's client type is accepted.
export interface ReadContractClient {
  readContract(parameters: any): Promise<unknown>;
}

/// delegate.xyz v2, deployed at the same address on every supported chain.
export const DELEGATE_REGISTRY_V2 = "0x00000000000000447e69651d841bD8D104Bed493" as const;

/// The one registry function the `delegateRegistry` policy reads.
export const delegateRegistryAbi = [
  {
    type: "function",
    name: "checkDelegateForERC721",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "from", type: "address" },
      { name: "contract", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "rights", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function revertOf(error: unknown): ContractFunctionRevertedError | null {
  if (error instanceof ContractFunctionRevertedError) return error;
  if (!(error instanceof BaseError)) return null;
  return (error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) ?? null;
}

/// True when the error is a contract revert (the chain answered), as opposed
///  to a transport or node failure (no answer).
export function isRevert(error: unknown): boolean {
  return revertOf(error) !== null;
}

/// The ERC-721 nonexistent-token errors: OpenZeppelin 5 `ERC721NonexistentToken(uint256)`
///  (selector 0x7e273289), and the revert strings of OpenZeppelin 4 and
///  older ("ERC721: invalid token ID", "owner query for nonexistent token").
const NONEXISTENT_SELECTOR = "0x7e273289";
const NONEXISTENT_REASON = /nonexistent token|invalid token id|token does not exist/i;

/// True only for a revert that says the token does not exist. Any other
///  revert (a paused contract, a proxy mid-upgrade, a custom guard) says
///  nothing about ownership, so it is a failed read, never a burn.
export function isNonexistentTokenRevert(error: unknown): boolean {
  const r = revertOf(error);
  if (!r) return false;
  return (
    r.data?.errorName === "ERC721NonexistentToken" ||
    r.signature === NONEXISTENT_SELECTOR ||
    (r.raw !== undefined && r.raw.toLowerCase().startsWith(NONEXISTENT_SELECTOR)) ||
    (typeof r.reason === "string" && NONEXISTENT_REASON.test(r.reason))
  );
}

// ownerOf, userOf and userExpires plus the error that marks nonexistence, so
// viem decodes it by name.
const readAbi = [
  ...erc721Abi,
  ...erc4907Abi,
  { type: "error", name: "ERC721NonexistentToken", inputs: [{ name: "tokenId", type: "uint256" }] },
] as const;

function nonZero(address: unknown): Address | null {
  if (typeof address !== "string") throw new Error(`unexpected read result: ${String(address)}`);
  return isAddressEqual(address as Address, zeroAddress) ? null : getAddress(address);
}

/// Production reader over a viem public client. Every call is a new
///  `eth_call`; nothing is cached, which is the point.
export function publicClientChainReader(client: ReadContractClient, options: { blockTag?: ReadBlockTag } = {}): ChainReader {
  const blockTag = options.blockTag ?? "latest";
  return {
    async ownerOf(token) {
      try {
        const owner = await client.readContract({
          address: token.contract,
          abi: readAbi,
          functionName: "ownerOf",
          args: [BigInt(token.tokenId)],
          blockTag,
        });
        return nonZero(owner);
      } catch (error) {
        // ERC-721 ownerOf reverts for a token that does not exist: an answer
        // (no owner), which the issuer may act on destructively (a burn). Any
        // other revert or failure is rethrown so the issuer answers 503, not
        // 403, and never voids a pass on it.
        if (isNonexistentTokenRevert(error)) return null;
        throw error;
      }
    },

    async userOf(token) {
      const args = [BigInt(token.tokenId)] as const;
      try {
        const [user, expires] = await Promise.all([
          client.readContract({ address: token.contract, abi: readAbi, functionName: "userOf", args, blockTag }),
          client.readContract({ address: token.contract, abi: readAbi, functionName: "userExpires", args, blockTag }),
        ]);
        return { user: nonZero(user), expires: BigInt(expires as bigint) };
      } catch (error) {
        // A nonexistent token has no user. Any other revert is a failed read:
        // reading it as "no rental" would hand an exclusive rental back to
        // the owner whenever the contract reverts (paused, upgrading).
        if (isNonexistentTokenRevert(error)) return { user: null, expires: 0n };
        throw error;
      }
    },

    async checkDelegateForERC721({ registry, to, from, token, rights }) {
      // A revert here is not an answer about delegation (the registry does
      // not revert for a missing delegation), so every failure is rethrown.
      const result = await client.readContract({
        address: registry,
        abi: delegateRegistryAbi,
        functionName: "checkDelegateForERC721",
        args: [to, from, token.contract, BigInt(token.tokenId), rights],
        blockTag,
      });
      return result === true;
    },
  };
}
