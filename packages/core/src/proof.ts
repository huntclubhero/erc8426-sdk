import type { Hex } from "viem";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { PROOF_HEADER, SIGNATURE_HEADER } from "./constants.js";

/// A signed challenge: the exact message text and its signature.
export interface ControlProof {
  message: string;
  signature: Hex;
}

/// The two headers that carry a control proof on a gated manifest request.
///  The message is base64url so the multi-line challenge fits in a header.
export function proofHeaders(proof: ControlProof): Record<string, string> {
  return {
    [PROOF_HEADER]: encodeBase64Url(proof.message),
    [SIGNATURE_HEADER]: proof.signature,
  };
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
  | { kind: "malformed"; reason: "encoding" | "signature" | "partial" }
  | { kind: "present"; proof: ControlProof };

/// Read a control proof from request headers. `absent` means neither header
///  was sent (answer 401 proof_required); `malformed` means the proof cannot
///  be decoded (answer 400); `present` still has to pass the floor.
export function readProofHeaders(headers: HeaderSource): ReadProofResult {
  const encoded = readHeader(headers, PROOF_HEADER);
  const signature = readHeader(headers, SIGNATURE_HEADER);
  if (encoded === undefined && signature === undefined) return { kind: "absent" };
  if (encoded === undefined || signature === undefined) return { kind: "malformed", reason: "partial" };
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
