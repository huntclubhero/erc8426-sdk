import { FORMAT_APPLE, FORMAT_GOOGLE, GOOGLE_SAVE_URL_PREFIX, MANIFEST_VERSION, METADATA_MIRROR_KEY } from "./constants.js";

/// The pass manifest a `passURI` resolves to (Pass manifest). It MUST be
///  served as `Content-Type: application/json`.
export interface PassManifest {
  /// Platform key to acquisition URL. At least one entry. `apple` and
  ///  `google` are defined by the standard; other keys MAY appear.
  formats: { apple?: string; google?: string } & Record<string, string>;
  /// Unix seconds of the last content change. Content freshness only: it says
  ///  nothing about whether the URLs in `formats` are still valid.
  updatedAt?: number;
  /// Manifest version. REQUIRED of a Pass Issuer, and 1 is the only value
  ///  defined: `createManifest` always emits it. It stays optional in this
  ///  type because a Client reads a manifest without it as version 1, so a
  ///  parsed manifest from an older issuer may not carry it.
  version?: number;
  /// OPTIONAL: who signs the passes of each format, so a Client can compare
  ///  it with the signer identifiers of the pass it acquires (and with the
  ///  contract's `passIssuer()`, when the contract commits to one).
  issuer?: PassIssuerIdentity;
}

/// The manifest's `issuer` member, and the JSON object a contract returns
///  from `passIssuer()` (Issuer identity commitment): format keys to objects
///  of string members that identify the platform signer of that format's
///  passes. For `apple` the members are the pass's `teamIdentifier` and
///  `passTypeIdentifier`; for `google`, the `issuerId` every object id of the
///  issuer account starts with. Members for other format keys are defined
///  with those keys.
export type PassIssuerIdentity = {
  apple?: { teamIdentifier: string; passTypeIdentifier: string } & Record<string, string>;
  google?: { issuerId: string } & Record<string, string>;
} & Record<string, Record<string, string>>;

/// The members the standard defines per format key. A Map, because the key
///  looked up comes from untrusted JSON: an object literal would answer
///  `constructor` or `toString` with what it inherits.
const ISSUER_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  [FORMAT_APPLE, ["teamIdentifier", "passTypeIdentifier"]],
  [FORMAT_GOOGLE, ["issuerId"]],
]);

/// Set an own, enumerable member under a key that came from untrusted JSON.
///  Plain assignment would run the `__proto__` setter for that one key.
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function getOwn<T>(source: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

export type PassIssuerParseResult =
  | { ok: true; issuer: PassIssuerIdentity; issues: ManifestIssue[] }
  | { ok: false; issues: ManifestIssue[] };

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

/// Validate a value against the shape of the manifest's `issuer` member: an
///  object whose keys are format keys and whose values are objects of string
///  members, with the members the standard defines for `apple` and `google`
///  present. `path` prefixes the issue paths.
export function parsePassIssuer(value: unknown, path = "issuer"): PassIssuerParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ level: "error", path, message: "issuer must be an object whose keys are format keys" }] };
  }
  const issues: ManifestIssue[] = [];
  const out: Record<string, Record<string, string>> = {};
  for (const [format, members] of Object.entries(value)) {
    const at = `${path}.${format}`;
    if (!isPlainObject(members)) {
      issues.push({ level: "error", path: at, message: "each issuer value must be an object of string members" });
      continue;
    }
    const clean: Record<string, string> = {};
    for (const [name, member] of Object.entries(members)) {
      if (typeof member !== "string") {
        issues.push({ level: "error", path: `${at}.${name}`, message: "issuer members must be strings" });
        continue;
      }
      setOwn(clean, name, member);
    }
    for (const name of ISSUER_MEMBERS.get(format) ?? []) {
      if (!Object.hasOwn(members, name)) {
        issues.push({ level: "error", path: `${at}.${name}`, message: `issuer.${format} is defined by its ${name} member, which is missing` });
      }
    }
    setOwn(out, format, clean);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issuer: out as PassIssuerIdentity, issues };
}

/// Parse the string a contract returns from `passIssuer()`: it MUST be a JSON
///  object with the shape of the manifest's `issuer` member.
export function parsePassIssuerJson(text: string, path = "passIssuer"): PassIssuerParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ level: "error", path, message: "passIssuer() must return a JSON object" }] };
  }
  return parsePassIssuer(value, path);
}

/// Compare two issuer objects member for member, as the standard asks of a
///  manifest's `issuer` and the contract's `passIssuer()`. Returns the paths
///  that differ (a format key or a member present on one side only, or a
///  member whose values are not the same string); empty when they are equal.
///  Key order is not a difference.
export function diffPassIssuer(a: PassIssuerIdentity, b: PassIssuerIdentity): string[] {
  const diffs: string[] = [];
  for (const format of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = getOwn(a, format);
    const right = getOwn(b, format);
    if (!left || !right) {
      diffs.push(format);
      continue;
    }
    for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!Object.hasOwn(left, name) || !Object.hasOwn(right, name) || left[name] !== right[name]) diffs.push(`${format}.${name}`);
    }
  }
  return diffs;
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
      // An acquisition URL is navigated to by clients, so any other scheme
      // (javascript:, data:, file:) would run in the client's origin. Only
      // https is accepted, plus http on localhost for development.
      const devHttp = parsed.protocol === "http:" && isLocalhost(parsed);
      if (parsed.protocol !== "https:" && !devHttp) {
        issues.push({ level: "error", path, message: "acquisition URL must be https (http only on localhost)" });
        continue;
      }
      // The standard defines `google` by function (the URL obtains a Google
      // Wallet pass) and leaves the link shape to the platform, so a URL that
      // is not a Save to Google Wallet link is kept: an issuer may route
      // through its own endpoint first. It is only flagged.
      if (key === FORMAT_GOOGLE && !url.startsWith(GOOGLE_SAVE_URL_PREFIX)) {
        issues.push({
          level: "warning",
          path,
          message: `the google URL is not a Save to Google Wallet link (${GOOGLE_SAVE_URL_PREFIX}...); the standard does not require one, but check that it reaches Google Wallet`,
        });
      }
      setOwn(out, key, url);
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

  // An absent version is read as version 1 (a Client SHOULD), so manifests
  // from issuers built before it was defined still resolve. A present value
  // this SDK does not understand is an error: a Client MUST NOT act on it.
  let version: number | undefined;
  if (value.version !== undefined) {
    const v = value.version;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
      issues.push({ level: "error", path: "version", message: "version MUST be the integer 1" });
    } else if (v !== MANIFEST_VERSION) {
      issues.push({
        level: "error",
        path: "version",
        message: `manifest version ${v} is not understood by this SDK (${MANIFEST_VERSION}); a Client MUST NOT act on it`,
      });
    } else {
      version = v;
    }
  }

  // issuer is OPTIONAL, and the standard gives a Client no rule for one that
  // is malformed, so the manifest is not refused for it: the member is
  // dropped with a warning, and the manifest reads as one that carries none.
  let issuer: PassIssuerIdentity | undefined;
  if (value.issuer !== undefined) {
    const parsed = parsePassIssuer(value.issuer);
    if (parsed.ok) issuer = parsed.issuer;
    else for (const issue of parsed.issues) issues.push({ ...issue, level: "warning", message: `${issue.message}; the issuer member is ignored` });
  }

  if (issues.some((i) => i.level === "error")) return { ok: false, issues };
  const manifest: PassManifest = { formats: out as PassManifest["formats"] };
  if (updatedAt !== undefined) manifest.updatedAt = updatedAt;
  if (version !== undefined) manifest.version = version;
  if (issuer !== undefined) manifest.issuer = issuer;
  return { ok: true, manifest, issues };
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/// Build a manifest from the URLs an issuer holds, dropping empty entries.
///  Carries `version: 1`, and the OPTIONAL `issuer` member when one is given
///  (its shape is checked; a contract that implements the issuer identity
///  commitment obliges its Pass Issuer to send it in every manifest).
export function createManifest(
  formats: PassManifest["formats"],
  updatedAt?: number | Date,
  options: { issuer?: PassIssuerIdentity } = {},
): PassManifest {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(formats)) if (typeof v === "string" && v.length > 0) setOwn(clean, k, v);
  if (Object.keys(clean).length === 0) throw new Error("a manifest needs at least one format");
  const manifest: PassManifest = { version: MANIFEST_VERSION, formats: clean as PassManifest["formats"] };
  if (updatedAt !== undefined) {
    manifest.updatedAt = updatedAt instanceof Date ? Math.floor(updatedAt.getTime() / 1000) : Math.floor(updatedAt);
  }
  if (options.issuer !== undefined) {
    const parsed = parsePassIssuer(options.issuer);
    if (!parsed.ok) throw new Error(`invalid manifest issuer: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    manifest.issuer = parsed.issuer;
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
