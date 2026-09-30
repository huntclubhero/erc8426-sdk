// SPDX-License-Identifier: MIT
// Runs every use-case demo in sequence, each on its own fresh anvil chain,
// and exits non-zero if any demo failed an expectation or threw.
import { main as eventTicket } from "./event-ticket/demo.js";
import { main as identityCredential } from "./identity-credential/demo.js";
import { main as membership } from "./membership/demo.js";
import { main as partnerApp } from "./partner-app/demo.js";
import { main as petGame } from "./pet-game/demo.js";
import { main as rental } from "./rental/demo.js";
import { main as staking } from "./staking/demo.js";
import { main as storedValueCard } from "./stored-value-card/demo.js";

const demos: Array<[string, () => Promise<void>]> = [
  ["pet-game", petGame],
  ["stored-value-card", storedValueCard],
  ["staking", staking],
  ["event-ticket", eventTicket],
  ["membership", membership],
  ["identity-credential", identityCredential],
  ["rental", rental],
  ["partner-app", partnerApp],
];

const results: Array<[string, string]> = [];
for (const [name, run] of demos) {
  const before = process.exitCode;
  process.exitCode = 0;
  try {
    await run();
    results.push([name, process.exitCode === 0 ? "green" : "FAILED expectations"]);
  } catch (e) {
    console.error(e);
    results.push([name, "THREW"]);
  }
  if (before) process.exitCode = before;
}

console.log("\nsummary");
for (const [name, status] of results) console.log(`  ${name.padEnd(22)} ${status}`);
process.exitCode = results.every(([, s]) => s === "green") ? 0 : 1;
