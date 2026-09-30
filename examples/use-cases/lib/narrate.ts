// SPDX-License-Identifier: MIT
import type { PassContent, PassField } from "@erc8426/core";
import { BaseError } from "viem";
import { WalletPassClientError } from "@erc8426/client";

import { revertName } from "./chain.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const cyan = paint("36");
const yellow = paint("33");

let stepNo = 0;
let failures = 0;

export function title(name: string, blurb: string): void {
  stepNo = 0;
  console.log("");
  console.log(bold(`=== ${name} ===`));
  console.log(dim(blurb));
}

export function step(text: string): void {
  stepNo += 1;
  console.log("");
  console.log(cyan(`${stepNo}. ${text}`));
}

export function say(text: string): void {
  console.log(`   ${text}`);
}

export function note(text: string): void {
  console.log(dim(`   ${text}`));
}

export function ok(text: string): void {
  console.log(green(`   ok      ${text}`));
}

export function refused(text: string): void {
  console.log(yellow(`   refused ${text}`));
}

/// Record an expectation that failed; the demo exits non-zero at the end.
export function fail(text: string): void {
  failures += 1;
  console.log(red(`   FAILED  ${text}`));
}

export function expect(condition: boolean, text: string): void {
  if (condition) ok(text);
  else fail(text);
}

export function push(tokenId: string, content: PassContent): void {
  const headline = [...(content.primary ?? []), ...(content.secondary ?? [])]
    .slice(0, 3)
    .map((f) => `${f.label} ${f.value}`)
    .join(", ");
  console.log(dim(`   push    pass #${tokenId} refreshed on device${content.voided ? " (VOIDED)" : ""}: ${headline}`));
}

function fields(label: string, list: PassField[] | undefined, max = 200): void {
  if (!list || list.length === 0) return;
  say(`${label.padEnd(10)}${list.map((f) => `${f.label}: ${truncate(String(f.value), max)}`).join(" | ")}`);
}

/// Print a pass the way a device would show it.
export function showPass(content: PassContent): void {
  say(`+ ${content.organizationName} | ${content.title}${content.voided ? "   [VOIDED]" : ""}`);
  fields("header", content.header);
  fields("primary", content.primary);
  fields("secondary", content.secondary);
  fields("auxiliary", content.auxiliary);
  fields("back", content.back, 60);
  if (content.barcode) say(`barcode   ${content.barcode.format}: ${truncate(content.barcode.message)}`);
  for (const link of content.links ?? []) say(`link      ${link.label}: ${truncate(link.url)}`);
}

export function truncate(s: string, n = 72): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/// Describe a refusal from the client, the issuer or the chain.
export function describeError(e: unknown): string {
  if (e instanceof WalletPassClientError) {
    const body = e.body as { message?: string } | undefined;
    const detail = body?.message ? `: ${body.message}` : "";
    // Issuer codes outside the core set arrive as action_refused or
    // server_error with the issuer's own code kept in serverCode; show the
    // more specific one.
    return `${e.status ?? e.source} ${e.serverCode ?? e.code}${detail}`;
  }
  const reverted = revertName(e);
  if (reverted) return `contract reverted (${reverted})`;
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

/// Run a step that MUST be refused, print why, and flag it if it went through.
export async function mustRefuse(what: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const why = describeError(e);
    refused(`${what}: ${why}`);
    return why;
  }
  fail(`${what} was NOT refused`);
  return "";
}

export function finish(): void {
  console.log("");
  if (failures > 0) {
    console.log(red(bold(`${failures} expectation(s) failed`)));
    process.exitCode = 1;
  } else {
    console.log(green(bold("demo complete: every expectation held")));
  }
}
