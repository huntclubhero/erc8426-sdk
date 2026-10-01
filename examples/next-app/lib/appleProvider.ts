import { appleFormatProvider, createApnsClient, MemoryApplePassStore, type AppleFormatProvider, type ApplePassStore } from "@erc8426/apple";

import type { ServerConfig } from "./config";
import { solidPng } from "./png";

/// Apple Wallet, added only when every APPLE_* credential is present. The
/// issuer serves the signed .pkpass from passFile at its own rotating link;
/// only the PassKit web service is mounted separately (app/apple route).
/// Apple calls that service only over public https, so on localhost passes
/// install but do not auto-update.
let provider: AppleFormatProvider | undefined;

/// `store` is shared (Redis) on serverless hosts, where device registrations
/// must outlive the instance that received them.
export function appleProvider(config: ServerConfig, shared?: ApplePassStore): AppleFormatProvider {
  const apple = config.apple!;
  if (provider) return provider;
  const store = shared ?? new MemoryApplePassStore();
  const certificates = {
    signerCert: apple.signerCert,
    signerKey: apple.signerKey,
    signerKeyPassphrase: apple.signerKeyPassphrase,
    wwdr: apple.wwdr,
  };
  const apns = apple.apns
    ? createApnsClient({
        certificate: { cert: apple.signerCert, key: apple.signerKey, passphrase: apple.signerKeyPassphrase },
        passTypeIdentifier: apple.passTypeIdentifier,
        store,
      })
    : undefined;
  provider = appleFormatProvider({
    passTypeIdentifier: apple.passTypeIdentifier,
    teamIdentifier: apple.teamIdentifier,
    certificates,
    origin: config.baseUrl,
    // Outside the issuer's /wallet-pass tree, mounted by app/apple/[...path].
    basePath: "/apple",
    store,
    ...(apns ? { apns } : {}),
    // One line per push, so the host's logs show whether APNs accepted it.
    // Push tokens are truncated: they identify a device.
    onPush: (serial, outcomes) =>
      console.log(
        `[apns] serial ${serial}: ${
          outcomes instanceof Error
            ? `error ${outcomes.message}`
            : outcomes.map((o) => `${o.token.slice(0, 8)} ${o.ok ? "ok" : "refused"} ${o.status ?? ""} ${o.reason ?? ""}`.trim()).join("; ") || "no registered devices"
        }`,
      ),
    images: {
      icon: { data: solidPng(29, 29, "#1f4e79"), data2x: solidPng(58, 58, "#1f4e79"), data3x: solidPng(87, 87, "#1f4e79") },
      logo: { data: solidPng(160, 50, "#1f4e79"), data2x: solidPng(320, 100, "#1f4e79") },
    },
  });
  return provider;
}

export function appleWebService(): AppleFormatProvider | undefined {
  return provider;
}
