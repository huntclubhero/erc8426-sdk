/// ABIs for the on-chain half of ERC-8426 and the reads the authorization
///  floor takes. `as const` so viem infers argument and return types.

export const walletPassAbi = [
  {
    type: "function",
    name: "passURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "PassUpdate",
    anonymous: false,
    inputs: [{ name: "tokenId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "BatchPassUpdate",
    anonymous: false,
    inputs: [
      { name: "fromTokenId", type: "uint256", indexed: false },
      { name: "toTokenId", type: "uint256", indexed: false },
    ],
  },
] as const;

export const erc165Abi = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const erc721Abi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

/// ERC-4907 rentals, for the Extended entitlement policy.
export const erc4907Abi = [
  {
    type: "function",
    name: "userOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "userExpires",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/// ERC-4906 metadata update events. An implementation that mirrors the
///  manifest into metadata can emit these alongside PassUpdate.
export const erc4906Abi = [
  {
    type: "event",
    name: "MetadataUpdate",
    anonymous: false,
    inputs: [{ name: "_tokenId", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "BatchMetadataUpdate",
    anonymous: false,
    inputs: [
      { name: "_fromTokenId", type: "uint256", indexed: false },
      { name: "_toTokenId", type: "uint256", indexed: false },
    ],
  },
] as const;
