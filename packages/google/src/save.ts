import { GOOGLE_SAVE_URL_PREFIX } from "@erc8426/core";
import { importPKCS8, SignJWT } from "jose";

import type { GoogleClass, GoogleObject, GoogleVertical } from "./objects.js";

/// Save to Google Wallet links. The link is a JWT signed by the issuer's
///  service account; opening it saves the referenced (or embedded) objects to
///  the viewer's Google account.

export interface ServiceAccount {
  client_email: string;
  /// PKCS#8 PEM, as in the downloaded service account JSON key.
  private_key: string;
}

export interface ObjectReference {
  vertical: GoogleVertical;
  id: string;
  classId: string;
}

export interface SaveUrlOptions {
  serviceAccount: ServiceAccount;
  /// Origins allowed to host the save button. Google refuses a save started
  ///  from any other origin; `saveOrigins` adds the www variant of each.
  origins: string[];
  /// Thin references to objects already inserted through the REST API. The
  ///  preferred form: the link stays short and constant-size, and the wallet
  ///  renders the stored object, so later PATCHes reach saved passes.
  objectIds?: ObjectReference[];
  /// Full objects embedded in the JWT (a "fat" link). Works without a REST
  ///  call but grows with content; past roughly 1800 characters Android adds
  ///  fail with a generic error, and an embedded class that drifts from the
  ///  stored class is rejected.
  objects?: GoogleObject[];
  /// Classes to embed alongside fat objects.
  classes?: GoogleClass[];
  /// Lifetime of the link. Defaults to one hour: the manifest mints a fresh
  ///  one on every resolution, so nothing needs a durable save link. Pass
  ///  null for no `exp` claim.
  ttlSeconds?: number | null;
  now?: Date;
}

/// Past this length a save link is at risk on Android.
export const SAVE_URL_SOFT_LIMIT = 1800;

const keyCache = new Map<string, ReturnType<typeof importPKCS8>>();

/// The parsed key, cached per PEM: importing parses the PEM and builds a
///  CryptoKey, and one key signs every token assertion and save link.
export function importServiceAccountKey(privateKey: string): ReturnType<typeof importPKCS8> {
  let p = keyCache.get(privateKey);
  if (!p) {
    p = importPKCS8(privateKey, "RS256");
    keyCache.set(privateKey, p);
    // A failed parse must not be cached forever.
    p.catch(() => keyCache.delete(privateKey));
  }
  return p;
}

/// Every configured URL's origin plus its www (or apex) variant, because a
///  site that answers on both hosts fails the save from whichever one is not
///  listed. localhost and IP hosts get no variant.
export function saveOrigins(urls: string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    const url = new URL(raw);
    out.add(url.origin);
    const host = url.hostname;
    if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) continue;
    const alt = new URL(url.origin);
    alt.hostname = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
    out.add(alt.origin);
  }
  return [...out];
}

export async function createSaveUrl(opts: SaveUrlOptions): Promise<string> {
  const refs = opts.objectIds ?? [];
  const objects = opts.objects ?? [];
  if (refs.length === 0 && objects.length === 0) throw new Error("createSaveUrl needs objectIds or objects");
  if (opts.origins.length === 0) throw new Error("createSaveUrl needs at least one origin");
  for (const o of opts.origins) {
    if (new URL(o).origin !== o) throw new Error(`origin must be a bare origin (scheme, host, port): ${o}`);
  }

  const payload: Record<string, unknown[]> = {};
  const push = (key: string, value: unknown) => (payload[key] ??= []).push(value);
  for (const c of opts.classes ?? []) push(`${c.vertical}Classes`, c.resource);
  for (const o of objects) push(`${o.vertical}Objects`, o.resource);
  for (const r of refs) push(`${r.vertical}Objects`, { id: r.id, classId: r.classId });

  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const ttl = opts.ttlSeconds === undefined ? 3600 : opts.ttlSeconds;
  const jwt = new SignJWT({ origins: opts.origins, typ: "savetowallet", payload })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(opts.serviceAccount.client_email)
    .setAudience("google")
    .setIssuedAt(now);
  if (ttl !== null) jwt.setExpirationTime(now + ttl);
  const signed = await jwt.sign(await importServiceAccountKey(opts.serviceAccount.private_key));
  return `${GOOGLE_SAVE_URL_PREFIX}${signed}`;
}
