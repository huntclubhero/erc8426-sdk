import type { LinkPageContext } from "./config.js";

/// Capability URL primitives (Acquisition URLs, The capability configuration).
///
///  A capability URL is "unguessable, high-entropy, and not derivable from
///  public data such as tokenId, pass serial numbers, or metadata fields".
///  Link tokens are 256 bits from the platform CSPRNG (Web Crypto, present in
///  Node 20+, browsers, Bun, Deno and Workers), base64url without padding, and
///  are bound server-side to exactly one (token, action) or (token, format).

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// A fresh 256-bit random value (43 base64url characters). Since 0.3.0 this
///  is the SEED a capability token is derived from, never the token itself:
///  see LinkKeyring.
export function newLinkToken(): string {
  return randomBase64Url(32);
}

/// Alias that says what the value is for.
export const newLinkSeed = newLinkToken;

/// Lowercase hex SHA-256 of a capability token: the key a link record is
///  stored under. A store holds digests and seeds, never a token, so a read
///  of the store alone yields no usable capability (Security
///  Considerations, store contents).
export async function linkDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/// Derives capability tokens from stored seeds with a secret held outside
///  the store (HMAC-SHA256), the spec's second way of keeping a store dump
///  from being a pile of live links. The token in a holder's URL is
///  `base64url(HMAC(secret, seed))`; the pass record keeps the seed and the
///  link store is keyed by the token's digest. Without the secret, neither
///  the seed nor the digest becomes a token; with it, every push can render
///  the holder's links again without storing them.
export class LinkKeyring {
  private readonly key: Promise<CryptoKey>;
  private readonly keyId: Promise<string>;
  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) throw new Error("linkSecret must be at least 32 bytes");
    // A fresh copy, so the key material sits in its own ArrayBuffer.
    const bytes = new Uint8Array(secret);
    this.key = crypto.subtle.importKey("raw", bytes.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    // A short fingerprint of the secret, stamped on each pass record so a
    // record bound under another secret (a rotation, a dev restart with an
    // ephemeral one) is recognized and re-bound. Reveals nothing usable: 64
    // bits of a hash of at least 256 bits of key material.
    this.keyId = crypto.subtle.digest("SHA-256", bytes).then((d) => Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(""));
  }

  /// Fingerprint of the secret (16 hex characters).
  id(): Promise<string> {
    return this.keyId;
  }

  /// The 43-character token for a stored seed.
  async token(seed: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(seed));
    let binary = "";
    for (const b of new Uint8Array(mac)) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /// The store key for a stored seed: the digest of its token.
  async digestOfSeed(seed: string): Promise<string> {
    return linkDigest(await this.token(seed));
  }
}

/// A fresh random secret for a LinkKeyring, for deployments that have not
///  configured one (development only: links die with the process).
export function ephemeralLinkSecret(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

/// A fresh random pass serial (128 bits). Random rather than derived from the
///  token or the holder, per the Issuer requirements on identifiers.
export function newSerial(): string {
  return randomBase64Url(16);
}

const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/// Cheap shape check before a store lookup.
export function isLinkTokenShape(value: string): boolean {
  return LINK_TOKEN_RE.test(value);
}

/// Headers every capability link page carries, HTML or JSON, built in or
///  custom. A link page is reached from a URL that is itself the capability,
///  so nothing about it may leak or be framed:
///   - `Cache-Control: no-store`: never cached by a shared cache or a browser.
///   - `X-Robots-Tag: noindex, nofollow`: a previewer or crawler that fetched
///     the link must not index the page (the HTML also carries the meta tag).
///   - `Referrer-Policy: no-referrer`: no navigation from the page (a link in
///     its text, the result page's links) sends the capability URL as a
///     Referer to another origin.
///   - `Content-Security-Policy: frame-ancestors 'none'`: no page may frame
///     the confirm page and clickjack its Confirm button.
export const LINK_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/// Re-wrap a response so its headers are mutable (a custom confirm page may
///  return a fetched one) and add LINK_PAGE_HEADERS. A custom page's own
///  Content-Security-Policy is kept and gains `frame-ancestors 'none'` when
///  it does not set that directive; every other header is set outright.
export function withLinkPageHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(LINK_PAGE_HEADERS)) {
    if (name === "Content-Security-Policy") {
      const existing = headers.get(name);
      if (existing === null) headers.set(name, value);
      else if (!/(^|;)\s*frame-ancestors\b/i.test(existing)) headers.set(name, `${existing.replace(/;\s*$/, "")}; ${value}`);
      continue;
    }
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem}button{font:inherit;padding:.75rem 1.5rem;border-radius:.5rem;border:0;background:#111;color:#fff}small{color:#666}</style></head><body>${body}</body></html>`;
}

/// A fresh value for the confirm page's hidden `attempt` field, so each
///  rendered page posts a body of its own: a deliberate second tap (a new
///  page, a new value) is a new request, while the browser resending the
///  same page's aborted POST (same value) is coalesced into the first.
export function newAttempt(): string {
  return randomBase64Url(9);
}

/// The built-in confirm page for a link opened from a pass. It is inert: the
///  action runs only when the form is submitted, which keeps the GET free of
///  side effects for devices, previewers and crawlers that prefetch links.
///  The form carries a per-render `attempt` field (see newAttempt).
export function defaultConfirmPage(ctx: LinkPageContext): Response {
  const html = page(
    ctx.description,
    `<h1>${escapeHtml(ctx.description)}</h1><p>Token ${escapeHtml(ctx.token.tokenId)}</p><form method="post" action="${escapeHtml(ctx.postUrl)}"><input type="hidden" name="action" value="${escapeHtml(ctx.action)}"><input type="hidden" name="attempt" value="${escapeHtml(newAttempt())}"><button type="submit">Confirm</button></form><p><small>${escapeHtml(ctx.bound)}</small></p>`,
  );
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/// Result page after a form POST from the confirm page.
export function resultPage(ok: boolean, message: string, status: number): Response {
  const html = page(ok ? "Done" : "Not done", `<h1>${ok ? "Done" : "Not done"}</h1><p>${escapeHtml(message)}</p>`);
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
