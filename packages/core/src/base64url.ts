/// base64url without padding (RFC 4648 section 5) over UTF-8 text. Works in
///  Node, browsers, and edge runtimes alike, none of which agree on Buffer.
///  The encoder never pads. The decoder also accepts correct trailing padding,
///  since ERC-8426 asks a Pass Issuer to accept a padded proof (earlier
///  revisions did not exclude it, and RFC 4648 section 3.2 pads by default).

export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): string {
  // Padding is one or two "=" at the very end, and only where it completes a
  // final group of four; "=" anywhere else, or the standard +/ alphabet, is
  // refused.
  const match = /^([A-Za-z0-9_-]*)(={0,2})$/.exec(value);
  if (!match) throw new Error("invalid base64url");
  const body = match[1]!;
  const pad = match[2]!;
  if (pad.length > 0 && (body.length + pad.length) % 4 !== 0) throw new Error("invalid base64url padding");
  const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((body.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
