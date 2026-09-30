// Testnet mode: deploy PetPass to any EVM chain and appoint the operator.
//
//   RPC_URL=https://sepolia.base.org \
//   OPERATOR_PRIVATE_KEY=0x... \
//   NEXT_PUBLIC_BASE_URL=https://your-app.vercel.app \
//   pnpm --filter @erc8426-examples/next-app deploy
//
// The key is read from the environment only and never printed. The operator
// becomes the collection owner (it mints) and its action operator (it relays
// capped care actions), so it needs gas on the target chain. Prints the env
// block for the app, without the key.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const artifact = JSON.parse(readFileSync(require.resolve("@erc8426/contracts/artifacts/PetPass.json"), "utf8"));

const rpcUrl = process.env.RPC_URL;
const key = process.env.OPERATOR_PRIVATE_KEY;
const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
if (!rpcUrl || !key || !/^0x[0-9a-fA-F]{64}$/.test(key) || !baseUrl) {
  console.error("Set RPC_URL, OPERATOR_PRIVATE_KEY (0x + 64 hex) and NEXT_PUBLIC_BASE_URL.");
  process.exit(2);
}
const lapseSeconds = BigInt(process.env.LAPSE_SECONDS ?? 3 * 24 * 3600);

const probe = createPublicClient({ transport: http(rpcUrl) });
const chainId = await probe.getChainId();
const chain = defineChain({
  id: chainId,
  name: `Chain ${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const operator = privateKeyToAccount(key);
const wallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });

console.log(`Deploying PetPass on chain ${chainId} from ${operator.address} ...`);
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [`${baseUrl}/wallet-pass/`, operator.address, lapseSeconds],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const contract = receipt.contractAddress;
const opHash = await wallet.writeContract({
  address: contract,
  abi: artifact.abi,
  functionName: "setActionOperator",
  args: [operator.address, true],
});
await publicClient.waitForTransactionReceipt({ hash: opHash });

console.log("\nAdd to your environment (and set OPERATOR_PRIVATE_KEY to the same key):\n");
console.log(`RPC_URL=${rpcUrl}`);
console.log(`CHAIN_ID=${chainId}`);
console.log(`CONTRACT_ADDRESS=${contract}`);
console.log(`DEPLOY_BLOCK=${receipt.blockNumber}`);
console.log(`NEXT_PUBLIC_BASE_URL=${baseUrl}`);
