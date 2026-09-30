import { FORMAT_APPLE, FORMAT_GOOGLE, GOOGLE_SAVE_URL_PREFIX, METADATA_MIRROR_KEY } from "./constants.js";

/// The pass manifest a `passURI` resolves to (Pass manifest).
export interface PassManifest {
  /// Platform key to acquisition URL. At least one entry. `apple` and
  ///  `google` are defined by the standard; other keys MAY appear.
  formats: { apple?: string; google?: string } & Record<string, string>;
  /// Unix seconds of the last content change. Content freshness only: it says
  ///  nothing about whether the URLs in `formats` are still valid.
  updatedAt?: number;
}

export type ManifestIssueLevel = "error" | "warning";

export interface ManifestIssue {
  level: ManifestIssueLevel;
  /// JSON path of the offending member, for example `formats.google`.
  path: string;
  message: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: PassManifest; issues: ManifestIssue[] }
  | { ok: false; issues: ManifestIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/// Validate a value against the manifest shape. Errors are MUST violations;
///  warnings are SHOULD-level or likely mistakes. Unknown format keys are kept
///  (so a caller can see them) but never validated beyond being URLs, because
///  clients MUST ignore format keys they do not recognize.
export function parseManifest(value: unknown): ManifestParseResult {
  const issues: ManifestIssue[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ level: "error", path: "", message: "manifest must be a JSON object" }] };
  }

  const formats = value.formats;
  const out: Record<string, string> = {};
  if (!isPlainObject(formats)) {
    issues.push({ level: "error", path: "formats", message: "formats is REQUIRED and must be an object" });
  } else {
    const keys = Object.keys(formats);
    if (keys.length === 0) {
      issues.push({ level: "error", path: "formats", message: "formats MUST contain at least one entry" });
    }
    for (const key of keys) {
      const url = formats[key];
      const path = `formats.${key}`;
      if (typeof url !== "string" || url.length === 0) {
        issues.push({ level: "error", path, message: "each format value must be an acquisition URL string" });
        continue;
      }
      const parsed = parseUrl(url);
      if (!parsed) {
        issues.push({ level: "error", path, message: "acquisition URL is not an absolute URL" });
        continue;
      }
      if (parsed.protocol !== "https:" && !isLocalhost(parsed)) {
        issues.push({ level: "warning", path, message: "acquisition URL is not https" });
      }
      if (key === FORMAT_GOOGLE && !url.startsWith(GOOGLE_SAVE_URL_PREFIX)) {
        issues.push({ level: "error", path, message: `the google format MUST be a Save to Google Wallet link (${GOOGLE_SAVE_URL_PREFIX}...)` });
        continue;
      }
      out[key] = url;
    }
  }

  let updatedAt: number | undefined;
  if (value.updatedAt !== undefined) {
    const u = value.updatedAt;
    if (typeof u !== "number" || !Number.isSafeInteger(u) || u < 0) {
      issues.push({ level: "error", path: "updatedAt", message: "updatedAt MUST be a Unix timestamp in integer seconds" });
    } else {
      // A value past the year 9999 in seconds is almost certainly milliseconds.
      if (u > 253402300799) {
        issues.push({ level: "warning", path: "updatedAt", message: "updatedAt looks like milliseconds; the standard uses seconds" });
      }
      updatedAt = u;
    }
  }

  if (issues.some((i) => i.level === "error")) return { ok: false, issues };
  const manifest: PassManifest = { formats: out as PassManifest["formats"] };
  if (updatedAt !== undefined) manifest.updatedAt = updatedAt;
  return { ok: true, manifest, issues };
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/// Build a manifest from the URLs an issuer holds, dropping empty entries.
export function createManifest(formats: PassManifest["formats"], updatedAt?: number | Date): PassManifest {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(formats)) if (typeof v === "string" && v.length > 0) clean[k] = v;
  if (Object.keys(clean).length === 0) throw new Error("a manifest needs at least one format");
  const manifest: PassManifest = { formats: clean as PassManifest["formats"] };
  if (updatedAt !== undefined) {
    manifest.updatedAt = updatedAt instanceof Date ? Math.floor(updatedAt.getTime() / 1000) : Math.floor(updatedAt);
  }
  return manifest;
}

/// The recognized platforms in a manifest, in a stable order.
export function manifestPlatforms(manifest: PassManifest): Array<typeof FORMAT_APPLE | typeof FORMAT_GOOGLE> {
  const out: Array<typeof FORMAT_APPLE | typeof FORMAT_GOOGLE> = [];
  if (manifest.formats.apple) out.push(FORMAT_APPLE);
  if (manifest.formats.google) out.push(FORMAT_GOOGLE);
  return out;
}

/// Read the optional metadata mirror (`wallet_pass`) out of tokenURI JSON.
///  The manifest reachable through passURI is authoritative when both exist.
export function readMetadataMirror(metadata: unknown): ManifestParseResult | null {
  if (!isPlainObject(metadata) || metadata[METADATA_MIRROR_KEY] === undefined) return null;
  return parseManifest(metadata[METADATA_MIRROR_KEY]);
}
