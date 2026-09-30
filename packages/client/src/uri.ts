/// URI handling for `passURI` and `tokenURI` values. Contracts return whatever
///  their deployer chose, so a client meets https links, content-addressed
///  ipfs:// and ar:// links, and inline data: URIs, and has to turn each into
///  something it can read.

export interface GatewayOptions {
  /// Base URL of an IPFS HTTP gateway. `ipfs://<cid>/<path>` resolves to
  ///  `<ipfsGateway>/ipfs/<cid>/<path>`.
  ipfsGateway?: string;
  /// Base URL of an Arweave gateway. `ar://<id>/<path>` resolves to
  ///  `<arweaveGateway>/<id>/<path>`.
  arweaveGateway?: string;
}

export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io";
export const DEFAULT_ARWEAVE_GATEWAY = "https://arweave.net";

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/// Turn a URI a contract returned into a fetchable URL. http(s) and data: URIs
///  pass through unchanged; ipfs:// and ar:// are rewritten onto a gateway.
///  Anything else is refused, because a client that fetched arbitrary schemes
///  would let a contract point it at file: or javascript: targets.
export function resolveUri(uri: string, options: GatewayOptions = {}): string {
  const value = uri.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("data:")) return value;
  if (lower.startsWith("ipfs://")) {
    // Tolerate the legacy ipfs://ipfs/<cid> form some collections shipped.
    const rest = value.slice("ipfs://".length).replace(/^ipfs\//i, "");
    return `${trimSlash(options.ipfsGateway ?? DEFAULT_IPFS_GATEWAY)}/ipfs/${rest}`;
  }
  if (lower.startsWith("ar://")) {
    return `${trimSlash(options.arweaveGateway ?? DEFAULT_ARWEAVE_GATEWAY)}/${value.slice("ar://".length)}`;
  }
  throw new Error(`unsupported URI scheme: ${value.split(":")[0] ?? value}`);
}

export interface UrlPolicy {
  /// Allow plain http to any host. Off by default: a contract or an issuer
  ///  response must not be able to point the client at http, where anything
  ///  on the path can read or rewrite it, or (server side) at an internal
  ///  service. Turn on only for server-side development against a non-local
  ///  http host.
  allowInsecureHttp?: boolean;
}

/// True for localhost, 127.0.0.0/8 and ::1, the only hosts plain http is
///  accepted for by default.
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.[0-9]{1,3}){3}$/.test(h);
}

/// Whether a URL may be fetched or navigated to: https always, http only on
///  a loopback host unless the policy allows it. Every other scheme
///  (javascript:, file:, data: and the rest) is refused.
export function isAllowedUrl(url: string, policy: UrlPolicy = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return policy.allowInsecureHttp === true || isLoopbackHost(u.hostname);
  return false;
}

/// The check a client runs before handing an acquisition URL to
///  window.location: https, or http on a loopback host for local testing.
///  Never widened by a policy, because a navigation target from a manifest
///  is attacker-influenced in the public configuration.
export function isSafeNavigationUrl(url: string): boolean {
  return isAllowedUrl(url);
}

export interface DataUri {
  mediaType: string;
  text: string;
}

/// Decode an RFC 2397 data: URI to text. Done by hand rather than through
///  fetch, since not every runtime (or test double) fetches data: URIs.
export function decodeDataUri(uri: string): DataUri {
  if (!/^data:/i.test(uri)) throw new Error("not a data: URI");
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("malformed data: URI");
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const parts = header.split(";");
  const base64 = parts.some((p) => p.toLowerCase() === "base64");
  const mediaType = parts[0] && parts[0].includes("/") ? parts[0].toLowerCase() : "text/plain";
  if (base64) {
    const binary = atob(decodeURIComponent(payload));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return { mediaType, text: new TextDecoder("utf-8").decode(bytes) };
  }
  return { mediaType, text: decodeURIComponent(payload) };
}

/// The web origin of a URI, or null when it has none (ipfs://, ar://, data:).
///  Content-addressed URIs carry no issuer origin at all, which a client
///  should show rather than hide.
export function uriOrigin(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/// True when `passUri` is served from one of `expectedOrigins`, the check the
///  spec's Phishing surface consideration asks for ("an origin consistent with
///  the collection's published web presence"). Entries may be origins or full
///  URLs (compared by origin), or `*.example.com` to accept any https
///  subdomain of example.com and example.com itself.
export function originMatches(passUri: string, expectedOrigins: readonly string[]): boolean {
  const origin = uriOrigin(passUri);
  if (origin === null) return false;
  const url = new URL(origin);
  for (const expected of expectedOrigins) {
    const entry = expected.trim();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2).toLowerCase();
      const host = url.hostname.toLowerCase();
      if (url.protocol === "https:" && (host === suffix || host.endsWith(`.${suffix}`))) return true;
      continue;
    }
    if (uriOrigin(entry) === origin) return true;
  }
  return false;
}

/// The directory-like base of a resolved pass URI: the URL without query or
///  fragment and without a trailing slash. SDK path conventions (challenge
///  fallback, signed actions) are relative to it.
export function passBase(resolvedPassUri: string): string {
  const url = new URL(resolvedPassUri);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
