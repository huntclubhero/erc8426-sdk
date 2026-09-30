/// The slice of PetPass this app calls, typed `as const` so viem checks
/// argument and return types. The full ABI ships in
/// @erc8426/contracts/abi/PetPass.json.
export const petPassAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "function", name: "feed", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "water", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "play", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "pet",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "lastFed", type: "uint64" },
          { name: "lastWatered", type: "uint64" },
          { name: "lastPlayed", type: "uint64" },
          { name: "cares", type: "uint32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "needs",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "hunger", type: "uint256" },
      { name: "thirst", type: "uint256" },
      { name: "boredom", type: "uint256" },
    ],
  },
  { type: "function", name: "diesAt", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "isAlive", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "lapseSeconds", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "passURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
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

/// The three care actions, in the order the pass shows them.
export const CARE_ACTIONS = ["feed", "water", "play"] as const;
export type CareAction = (typeof CARE_ACTIONS)[number];
