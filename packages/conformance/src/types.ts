import type { Client, Hex } from "viem";

/// RFC 2119 level of the requirement a check enforces. A failed MUST makes the
///  implementation non-conforming; a failed SHOULD is reported as a warning.
export type CheckLevel = "MUST" | "SHOULD";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  /// Stable identifier, for example `gated.non-owner-403`.
  id: string;
  /// One-line statement of what is being checked.
  title: string;
  /// The section of ERC-8426 the check enforces.
  section: string;
  level: CheckLevel;
  status: CheckStatus;
  /// What was observed, or why the check was skipped.
  detail?: string;
}

export interface ConformanceOptions {
  /// JSON-RPC URL of the chain the contract is on. Ignored when
  ///  `publicClient` is given.
  rpcUrl?: string;
  publicClient?: Client;
  contract: string;
  tokenId: bigint | number | string;
  /// A token id that does not exist, for the passURI revert check. Defaults
  ///  to the largest uint256.
  nonexistentTokenId?: bigint | number | string;
  /// Private key of the token's current owner. Enables the owner checks of
  ///  the gated configuration (200 with no-store, single-use nonce). Never
  ///  logged or included in the report.
  ownerPrivateKey?: Hex;
  fetch?: typeof fetch;
  ipfsGateway?: string;
  arweaveGateway?: string;
  /// Per-request timeout in milliseconds. Default 15000.
  timeoutMs?: number;
}

export interface ConformanceSummary {
  pass: number;
  /// Failed MUST checks.
  fail: number;
  /// Failed SHOULD checks.
  warn: number;
  skip: number;
}

export interface ConformanceReport {
  chainId: number | null;
  contract: string;
  tokenId: string;
  /// The configuration detected from the manifest response.
  configuration: "public" | "gated" | "unknown";
  passUri: string | null;
  manifestUrl: string | null;
  /// Address of the supplied owner key, when one was used.
  ownerAddress: string | null;
  checks: CheckResult[];
  summary: ConformanceSummary;
  /// False when any MUST check failed.
  ok: boolean;
}
