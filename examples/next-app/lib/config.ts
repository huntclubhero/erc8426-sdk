import { getAddress, isAddress, type Address, type Hex } from "viem";

/// Server configuration, read from the environment at request time so one
/// build runs against any chain. `pnpm chain` writes these for local mode;
/// see .env.example for testnet and real wallet mode.
export interface ServerConfig {
  rpcUrl: string;
  chainId: number;
  contract: Address;
  operatorKey: Hex;
  /// Canonical origin of this app. The SIWE domain is its host, so clients
  ///  (which refuse any other domain) can sign the challenges.
  baseUrl: string;
  domain: string;
  deployBlock: bigint;
  /// The in-browser burner wallet and its faucet. Only ever on for anvil.
  devWallet: boolean;
  mintEnabled: boolean;
  apple: AppleEnv | null;
  google: GoogleEnv | null;
}

export interface AppleEnv {
  passTypeIdentifier: string;
  teamIdentifier: string;
  signerCert: string;
  signerKey: string;
  signerKeyPassphrase: string | undefined;
  wwdr: string;
  apns: boolean;
}

export interface GoogleEnv {
  issuerId: string;
  serviceAccount: { client_email: string; private_key: string };
  classSuffix: string;
}

/// What the browser is told. Never includes a key or credential.
export interface PublicConfig {
  configured: true;
  chainId: number;
  contract: Address;
  baseUrl: string;
  devWallet: boolean;
  mintEnabled: boolean;
  platforms: string[];
}

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; error: string };

export const ANVIL_CHAIN_ID = 31337;

/// PEM from an env var: literal PEM, PEM with escaped newlines (the form most
///  hosting dashboards keep), or base64 of the PEM.
function pem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    // fall through
  }
  return undefined;
}

function appleEnv(env: NodeJS.ProcessEnv): AppleEnv | null {
  const signerCert = pem(env.APPLE_SIGNER_CERT);
  const signerKey = pem(env.APPLE_SIGNER_KEY);
  const wwdr = pem(env.APPLE_WWDR);
  if (!env.APPLE_PASS_TYPE_ID || !env.APPLE_TEAM_ID || !signerCert || !signerKey || !wwdr) return null;
  return {
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    signerCert,
    signerKey,
    signerKeyPassphrase: env.APPLE_SIGNER_KEY_PASSPHRASE || undefined,
    wwdr,
    apns: env.APPLE_APNS === "1",
  };
}

function googleEnv(env: NodeJS.ProcessEnv): GoogleEnv | null {
  if (!env.GOOGLE_ISSUER_ID || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    if (typeof json.client_email !== "string" || typeof json.private_key !== "string") return null;
    return {
      issuerId: env.GOOGLE_ISSUER_ID,
      serviceAccount: { client_email: json.client_email, private_key: json.private_key },
      classSuffix: env.GOOGLE_CLASS_SUFFIX || "erc8426_petpass_example",
    };
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const missing = ["RPC_URL", "CHAIN_ID", "CONTRACT_ADDRESS", "OPERATOR_PRIVATE_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) {
    return { ok: false, error: `Missing ${missing.join(", ")}. Run \`pnpm chain\` for local mode, or see .env.example.` };
  }
  const chainId = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: "CHAIN_ID must be a positive integer" };
  if (!isAddress(env.CONTRACT_ADDRESS!)) return { ok: false, error: "CONTRACT_ADDRESS is not an address" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.OPERATOR_PRIVATE_KEY!)) return { ok: false, error: "OPERATOR_PRIVATE_KEY is not a 32-byte hex key" };

  const baseUrl = (env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  let domain: string;
  try {
    domain = new URL(baseUrl).host;
  } catch {
    return { ok: false, error: "NEXT_PUBLIC_BASE_URL is not a URL" };
  }

  return {
    ok: true,
    config: {
      rpcUrl: env.RPC_URL!,
      chainId,
      contract: getAddress(env.CONTRACT_ADDRESS!),
      operatorKey: env.OPERATOR_PRIVATE_KEY as Hex,
      baseUrl,
      domain,
      deployBlock: BigInt(env.DEPLOY_BLOCK || "0"),
      // Belt and braces: the flag AND an anvil chain id, so a testnet deploy
      // with a copied .env never exposes a faucet.
      devWallet: env.DEV_WALLET === "1" && chainId === ANVIL_CHAIN_ID,
      mintEnabled: env.MINT_API !== "off",
      apple: appleEnv(env),
      google: googleEnv(env),
    },
  };
}

export function publicConfig(config: ServerConfig): PublicConfig {
  return {
    configured: true,
    chainId: config.chainId,
    contract: config.contract,
    baseUrl: config.baseUrl,
    devWallet: config.devWallet,
    mintEnabled: config.mintEnabled,
    platforms: [...(config.apple ? ["apple"] : []), ...(config.google ? ["google"] : [])],
  };
}
