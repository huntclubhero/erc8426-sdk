import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/// 256 bits from the OS CSPRNG, base64url. Used for per-pass authentication
///  tokens: every pass gets its own, so one leaked token exposes one pass and
///  rotating it on transfer cuts off exactly the previous holder.
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/// Constant-time string compare. A length mismatch returns early, which only
///  reveals the length, and every token this package mints has a fixed length.
export function safeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hmacHex(secret: string | Uint8Array, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/// ISO 8601 without milliseconds. PassKit parses W3C dates, and the seconds
///  form is the one both production deployments ship.
export function passDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/// Response bodies need an ArrayBuffer-backed view under TypeScript's DOM
///  types. Copy only when the bytes sit on a SharedArrayBuffer.
export function responseBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}
