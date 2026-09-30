/// Google Wallet resource ids are `<issuerId>.<suffix>`: the numeric issuer
///  id from the Google Pay and Wallet Console, a dot, and a suffix of
///  letters, digits, dots, underscores or hyphens.

const ISSUER_RE = /^[0-9]+$/;
const SUFFIX_RE = /^[A-Za-z0-9._-]+$/;

/// The Wallet API accepts only the NUMERIC issuer id. The alphanumeric
///  merchant id from the Pay console looks similar and 400s every call, a
///  trap that has run silent in production for weeks.
export function assertIssuerId(issuerId: string): void {
  if (!ISSUER_RE.test(issuerId)) {
    throw new Error(`invalid Google Wallet issuer id "${issuerId}": use the numeric issuer id from the Wallet console, not a merchant id`);
  }
}

export function assertSuffix(suffix: string, what = "suffix"): void {
  if (!SUFFIX_RE.test(suffix)) {
    throw new Error(`invalid Google Wallet ${what} "${suffix}": only letters, digits, ".", "_" and "-" are allowed`);
  }
}

export function resourceId(issuerId: string, suffix: string): string {
  assertIssuerId(issuerId);
  assertSuffix(suffix);
  return `${issuerId}.${suffix}`;
}

/// A suffix for a pass serial. A serial already in the allowed alphabet is
///  used as is; any other serial is base64url-encoded (whose alphabet is a
///  subset of the allowed one) so distinct serials never collapse onto one id,
///  as a character-stripping sanitizer would let them.
export function suffixForSerial(serial: string): string {
  if (serial.length === 0) throw new Error("serial must not be empty");
  return SUFFIX_RE.test(serial) ? serial : `b64_${Buffer.from(serial, "utf8").toString("base64url")}`;
}
