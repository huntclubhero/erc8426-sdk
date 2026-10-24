import { googleFormatProvider, googleWalletClient, type GoogleFormatProvider, type GoogleObjectStore } from "@erc8426/google";

import type { ServerConfig } from "./config";

/// Google Wallet, added only when GOOGLE_ISSUER_ID and the service account are
/// present. Save links are minted on every manifest resolution and expire in
/// an hour, which the spec allows ("acquisition URLs MAY be short-lived").
/// Google cannot fetch images from localhost, so unhosted images are omitted.
export function googleProvider(config: ServerConfig, store?: GoogleObjectStore): GoogleFormatProvider {
  const google = config.google!;
  return googleFormatProvider({
    ...(store ? { store } : {}),
    client: googleWalletClient({ serviceAccount: google.serviceAccount, issuerId: google.issuerId }),
    classSuffix: google.classSuffix,
    // The deployed origin only, from NEXT_PUBLIC_BASE_URL. saveOrigins would
    // add a www variant, which a vercel.app host does not have.
    origins: [new URL(config.baseUrl).origin],
    unhostedImages: "omit",
    messageFor: () => ({ header: "Your pet changed", body: "Open the pass to see how it is doing." }),
    onError: (err, where) => console.warn(`[google] ${where}: ${err.message}`),
  });
}
