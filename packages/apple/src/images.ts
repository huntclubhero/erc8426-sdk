import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { ImageSource } from "@erc8426/core";

/// Apple embeds image bytes in the signed bundle, so a URL source is fetched
///  at build time. That makes the builder a server-side fetcher of URLs that
///  may come from token metadata, so it is bounded three ways: size and time
///  (builds sit on the device refresh path), and destination (https to a
///  public address only, on every redirect hop, so a URL cannot point the
///  server at its own network).

export interface ImageFetchOptions {
  /// Defaults to the global fetch.
  fetch?: typeof fetch;
  /// Per image. Defaults to 5 seconds.
  timeoutMs?: number;
  /// Per image. Defaults to 2 MiB, well above any sane pass asset.
  maxBytes?: number;
  /// Allow http and private, loopback and link-local destinations. For local
  ///  development only; never enable it where URLs come from token data.
  allowPrivateNetwork?: boolean;
  /// Resolve a host to its addresses. Defaults to the system resolver.
  lookup?(hostname: string): Promise<string[]>;
  /// Redirect hops followed, each re-checked. Defaults to 3.
  maxRedirects?: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(data: Uint8Array): boolean {
  return data.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => data[i] === b);
}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/// True for any address that is not publicly routable: loopback, private,
///  carrier-grade NAT, link-local (including cloud metadata at
///  169.254.169.254), multicast and reserved, in IPv4 and IPv6, and IPv4
///  mapped into IPv6.
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return ipv4Private(mapped[1]!);
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith("::ffff:");
  }
  return true;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

/// Refuse a destination that is not https to a public address. Every
///  resolved address must be public, so a name with one private record is
///  refused. The fetch resolves again afterwards; a resolver that answers
///  differently the second time (DNS rebinding) is a residual this check
///  narrows but cannot close without pinning the connection.
async function assertPublicDestination(url: URL, opts: ImageFetchOptions): Promise<void> {
  if (opts.allowPrivateNetwork) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`image url must be http(s): ${url}`);
    return;
  }
  if (url.protocol !== "https:") throw new Error(`image url must be https: ${url}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`image url points at a private address: ${url}`);
  const addresses = isIP(host) ? [host] : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`image url points at a private address: ${url}`);
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`image ${url} is ${declared} bytes, over the ${maxBytes} byte cap`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  // Stream with a running count, because Content-Length can be absent or wrong.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`image ${url} exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function fetchImage(url: string, opts: ImageFetchOptions = {}): Promise<Uint8Array> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`image url is not a valid URL: ${url}`);
  }
  const doFetch = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
  const maxRedirects = opts.maxRedirects ?? 3;
  // Redirects are followed by hand so each hop gets the same destination
  // check; an automatic follow would let a public URL bounce to a private one.
  for (let hop = 0; ; hop += 1) {
    await assertPublicDestination(current, opts);
    const res = await doFetch(current.toString(), { signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`image ${current} redirected without a Location`);
      if (hop >= maxRedirects) throw new Error(`image ${url} redirected more than ${maxRedirects} times`);
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`image ${current} answered ${res.status}`);
    const data = await readCapped(res, opts.maxBytes ?? 2 * 1024 * 1024, current.toString());
    // Wallet renders PNG only, and a wrong format fails silently on the
    // device (the pass installs with a blank slot), so refuse it here.
    if (!isPng(data)) throw new Error(`image ${current} is not a PNG`);
    return data;
  }
}

/// Resolve one image slot into bundle entries: `<name>.png`, and the @2x / @3x
///  variants when supplied. Bytes win over a URL for the base resolution.
export async function resolveImage(
  name: string,
  source: ImageSource,
  opts: ImageFetchOptions = {},
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const base = source.data ?? (source.url ? await fetchImage(source.url, opts) : undefined);
  if (base) out[`${name}.png`] = base;
  if (source.data2x) out[`${name}@2x.png`] = source.data2x;
  if (source.data3x) out[`${name}@3x.png`] = source.data3x;
  for (const [file, bytes] of Object.entries(out)) {
    if (!isPng(bytes)) throw new Error(`image ${file} is not a PNG`);
  }
  return out;
}
