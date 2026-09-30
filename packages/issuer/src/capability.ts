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
