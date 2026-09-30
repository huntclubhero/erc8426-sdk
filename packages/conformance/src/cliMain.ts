import type { Client, Hex } from "viem";

import { formatReport } from "./format.js";
import { runConformance } from "./run.js";
import type { ConformanceOptions } from "./types.js";

export const DEFAULT_OWNER_KEY_ENV = "ERC8426_OWNER_KEY";

export const USAGE = `Usage: erc8426-conformance --rpc <url> --contract <address> --token <id> [options]

Checks a token contract and the pass server its passURI points at against
every requirement of ERC-8426 it can observe from outside.

Options:
  --rpc <url>              JSON-RPC URL (or env ERC8426_RPC_URL)
  --contract <address>     Token contract address
  --token <id>             A token id that exists
  --nonexistent-token <id> A token id that does not exist (default: max uint256)
  --owner-key-env <NAME>   Name of an env var holding the owner's private key
                           (default ${DEFAULT_OWNER_KEY_ENV}); enables the owner checks
  --ipfs-gateway <url>     IPFS gateway for ipfs:// URIs
  --arweave-gateway <url>  Arweave gateway for ar:// URIs
  --timeout <ms>           Per-request timeout (default 15000)
  --json                   Print the report as JSON
  --help                   Show this help

The private key is only ever read from the environment, never from a flag,
so it stays out of shell history and process listings.

Exit codes: 0 conforms, 1 a MUST check failed, 2 usage error.`;

export interface ParsedArgs {
  rpc?: string;
  contract?: string;
  token?: string;
  nonexistentToken?: string;
  ownerKeyEnv: string;
  ipfsGateway?: string;
  arweaveGateway?: string;
  timeout?: number;
  json: boolean;
  help: boolean;
}

const VALUE_FLAGS: Record<string, keyof ParsedArgs> = {
  "--rpc": "rpc",
  "--contract": "contract",
  "--token": "token",
  "--nonexistent-token": "nonexistentToken",
  "--owner-key-env": "ownerKeyEnv",
  "--ipfs-gateway": "ipfsGateway",
  "--arweave-gateway": "arweaveGateway",
  "--timeout": "timeout",
};

/// Parse argv by hand (no CLI framework). Accepts `--flag value` and
///  `--flag=value`. Throws with a usage message on anything unknown, and
///  refuses a key passed as a flag outright.
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { ownerKeyEnv: DEFAULT_OWNER_KEY_ENV, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (/^--(owner-)?(private-)?key$/.test(name) || name === "--owner-private-key") {
        throw new Error(`${name} is not accepted: put the key in an environment variable and pass --owner-key-env <NAME>`);
      }
      const key = VALUE_FLAGS[name];
      if (!key) throw new Error(`unknown argument: ${name}`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "") throw new Error(`${name} needs a value`);
      if (key === "timeout") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout must be a positive number of milliseconds");
        out.timeout = n;
      } else {
        (out as unknown as Record<string, string>)[key] = value;
      }
    }
  }
  return out;
}

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /// Test seams.
  publicClient?: Client;
  fetch?: typeof fetch;
}

/// Run the CLI and return the exit code. Kept apart from the bin entry so it
///  can be tested without spawning a process.
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const rpc = args.rpc ?? io.env.ERC8426_RPC_URL;
  const missing = [
    !rpc && !io.publicClient ? "--rpc" : null,
    !args.contract ? "--contract" : null,
    !args.token ? "--token" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    io.stderr(`missing ${missing.join(", ")}\n\n${USAGE}\n`);
    return 2;
  }

  const rawKey = io.env[args.ownerKeyEnv]?.trim();
  let ownerPrivateKey: Hex | undefined;
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      // Name the variable, never echo its value.
      io.stderr(`environment variable ${args.ownerKeyEnv} is not a 32-byte hex private key\n`);
      return 2;
    }
    ownerPrivateKey = key as Hex;
  }

  const options: ConformanceOptions = {
    contract: args.contract!,
    tokenId: args.token!,
    ...(io.publicClient ? { publicClient: io.publicClient } : { rpcUrl: rpc! }),
    ...(args.nonexistentToken ? { nonexistentTokenId: args.nonexistentToken } : {}),
    ...(ownerPrivateKey ? { ownerPrivateKey } : {}),
    ...(args.ipfsGateway ? { ipfsGateway: args.ipfsGateway } : {}),
    ...(args.arweaveGateway ? { arweaveGateway: args.arweaveGateway } : {}),
    ...(args.timeout ? { timeoutMs: args.timeout } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };

  try {
    const report = await runConformance(options);
    io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (e) {
    io.stderr(`conformance run failed: ${(e as Error).message}\n`);
    return 2;
  }
}
