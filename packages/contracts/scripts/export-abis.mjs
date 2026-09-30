// SPDX-License-Identifier: MIT
// Copies the ABI arrays of the package's public contracts from Foundry's
// build output (out/) into abi/<Contract>.json, and, for every deployable
// contract, { abi, bytecode } into artifacts/<Contract>.json, so TypeScript
// code can import and deploy them without Foundry. Run `forge build` first.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const abiDir = join(root, "abi");
const artifactDir = join(root, "artifacts");

// [source file name, contract name]
const CONTRACTS = [
  ["IERC721WalletPass.sol", "IERC721WalletPass"],
  ["ERC721WalletPass.sol", "ERC721WalletPass"],
  ["ERC721WalletPassRentable.sol", "ERC721WalletPassRentable"],
  ["BoundedAction.sol", "BoundedAction"],
  ["IERC4907.sol", "IERC4907"],
  ["IERC5192.sol", "IERC5192"],
  ["PetPass.sol", "PetPass"],
  ["StoredValueCard.sol", "StoredValueCard"],
  ["StakingPass.sol", "StakingPass"],
  ["EventTicketPass.sol", "EventTicketPass"],
  ["MembershipPass.sol", "MembershipPass"],
  ["IdentityCredential.sol", "IdentityCredential"],
  ["RentalPass.sol", "RentalPass"],
  ["MockERC20.sol", "MockERC20"],
  ["MockERC721.sol", "MockERC721"],
  ["MockSmartAccount.sol", "MockSmartAccount"],
];

if (!existsSync(outDir)) {
  console.error("out/ not found: run `forge build` in packages/contracts first.");
  process.exit(1);
}

mkdirSync(abiDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });
for (const [file, name] of CONTRACTS) {
  const artifactPath = join(outDir, file, `${name}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`missing artifact: ${artifactPath}`);
    process.exit(1);
  }
  const { abi, bytecode } = JSON.parse(readFileSync(artifactPath, "utf8"));
  writeFileSync(join(abiDir, `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  // Interfaces and abstract contracts have no creation code: ABI only.
  const code = bytecode?.object ?? "0x";
  if (code !== "0x") {
    const artifact = { contractName: name, abi, bytecode: code };
    writeFileSync(join(artifactDir, `${name}.json`), JSON.stringify(artifact, null, 2) + "\n");
  }
  console.log(`${name}: ${abi.length} abi entries${code !== "0x" ? " + bytecode" : ""}`);
}
