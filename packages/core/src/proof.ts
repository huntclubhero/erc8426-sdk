import type { Hex } from "viem";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { LEGACY_PROOF_HEADER, LEGACY_SIGNATURE_HEADER, PROOF_HEADER, SIGNATURE_HEADER } from "./constants.js";

/// A signed challenge: the exact message text and its signature.
export interface ControlProof {
  message: string;
  signature: Hex;
}

export interface ProofHeadersOptions {
  /// Also send the pre-0.3.0 X- names, so an issuer that has not moved to
  ///  the RFC 6648 names still reads the proof. Default true for this
  ///  release; a later minor flips the default and then drops the names.
  legacy?: boolean;
}

/// The headers that carry a control proof on a gated manifest request: the
///  message base64url encoded (so the multi-line challenge fits in a header)
///  and the signature as hex, under `Wallet-Pass-Proof` and
///  `Wallet-Pass-Signature`, and by default under the X- names too.
export function proofHeaders(proof: ControlProof, options: ProofHeadersOptions = {}): Record<string, string> {
  const encoded = encodeBase64Url(proof.message);
  const headers: Record<string, string> = {
    [PROOF_HEADER]: encoded,
    [SIGNATURE_HEADER]: proof.signature,
  };
  if (options.legacy !== false) {
    headers[LEGACY_PROOF_HEADER] = encoded;
    headers[LEGACY_SIGNATURE_HEADER] = proof.signature;
  }
  return headers;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export type ReadProofResult =
  | { kind: "absent" }
  | {
      kind: "malformed";
      /// `mixed`: a proof under one name form and a signature under the other,
      ///  with no complete pair (refuse as invalid_request). `partial` is no
      ///  longer returned: a lone header is `absent`, as the spec treats
      ///  anything short of a complete pair as a missing proof.
      reason: "encoding" | "signature" | "mixed" | "partial";
    }
  | { kind: "present"; proof: ControlProof };

/// Read a control proof from request headers. Each name form is a pair: both
///  RFC 6648 names (`Wallet-Pass-Proof`, `Wallet-Pass-Signature`) or both X-
///  names. A complete unprefixed pair wins when both complete pairs are sent;
///  a complete X- pair is used otherwise. A proof under one form with a
///  signature under the other, and no complete pair, is `malformed` with
///  reason `mixed` (answer 400 invalid_request); the two are never stitched
///  together. Anything else short of a complete pair, a lone header included,
///  is `absent` (answer 401 proof_required). `malformed` also covers a proof
///  that cannot be decoded; `present` still has to pass the floor.
export function readProofHeaders(headers: HeaderSource): ReadProofResult {
  const proofNew = readHeader(headers, PROOF_HEADER) || undefined;
  const signatureNew = readHeader(headers, SIGNATURE_HEADER) || undefined;
  const proofLegacy = readHeader(headers, LEGACY_PROOF_HEADER) || undefined;
  const signatureLegacy = readHeader(headers, LEGACY_SIGNATURE_HEADER) || undefined;
  let encoded: string;
  let signature: string;
  if (proofNew && signatureNew) {
    encoded = proofNew;
    signature = signatureNew;
  } else if (proofLegacy && signatureLegacy) {
    encoded = proofLegacy;
    signature = signatureLegacy;
  } else if ((proofNew || signatureNew) && (proofLegacy || signatureLegacy)) {
    return { kind: "malformed", reason: "mixed" };
  } else {
    return { kind: "absent" };
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length % 2 !== 0) {
    return { kind: "malformed", reason: "signature" };
  }
  let message: string;
  try {
    message = decodeBase64Url(encoded);
  } catch {
    return { kind: "malformed", reason: "encoding" };
  }
  return { kind: "present", proof: { message, signature: signature as Hex } };
}
