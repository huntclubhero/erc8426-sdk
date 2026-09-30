// SPDX-License-Identifier: MIT
import { createServer, type Server } from "node:http";

import { toNodeHandler, type Issuer } from "@erc8426/issuer";

/// Extra routes a demo mounts beside the issuer (a venue endpoint, a partner
///  app page). Return null to fall through to the issuer.
export type ExtraRoute = (request: Request) => Promise<Response | null>;

export interface IssuerServer {
  baseUrl: string;
  /// The SIWE domain, which must equal baseUrl's host.
  domain: string;
  issuer: Issuer;
  stop(): Promise<void>;
}

/// Listen on a random local port first, then build the issuer, because the
///  issuer's baseUrl and domain must name the exact origin that serves it
///  (clients refuse to sign a challenge for any other domain).
export async function startIssuerServer(
  build: (origin: { baseUrl: string; domain: string }) => Issuer,
  extra: ExtraRoute[] = [],
): Promise<IssuerServer> {
  let issuer: Issuer | undefined;
  const handler = toNodeHandler(async (request: Request) => {
    for (const route of extra) {
      const res = await route(request);
      if (res) return res;
    }
    if (!issuer) return new Response("starting", { status: 503 });
    return issuer.handler(request);
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const domain = `127.0.0.1:${port}`;
  const baseUrl = `http://${domain}`;
  issuer = build({ baseUrl, domain });
  return {
    baseUrl,
    domain,
    issuer,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
