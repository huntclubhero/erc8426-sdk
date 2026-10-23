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

/// A fresh 256-bit capability token (43 base64url characters).
export function newLinkToken(): string {
  return randomBase64Url(32);
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

/// The built-in confirm page for a link opened from a pass. It is inert: the
///  action runs only when the form is submitted, which keeps the GET free of
///  side effects for devices, previewers and crawlers that prefetch links.
export function defaultConfirmPage(ctx: LinkPageContext): Response {
  const html = page(
    ctx.description,
    `<h1>${escapeHtml(ctx.description)}</h1><p>Token ${escapeHtml(ctx.token.tokenId)}</p><form method="post" action="${escapeHtml(ctx.postUrl)}"><input type="hidden" name="action" value="${escapeHtml(ctx.action)}"><button type="submit">Confirm</button></form><p><small>${escapeHtml(ctx.bound)}</small></p>`,
  );
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/// Result page after a form POST from the confirm page.
export function resultPage(ok: boolean, message: string, status: number): Response {
  const html = page(ok ? "Done" : "Not done", `<h1>${ok ? "Done" : "Not done"}</h1><p>${escapeHtml(message)}</p>`);
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
