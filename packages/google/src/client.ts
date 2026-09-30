import { SignJWT } from "jose";

import { assertIssuerId } from "./ids.js";
import type { GoogleResource, GoogleResourceType } from "./objects.js";
import { createSaveUrl, importServiceAccountKey, type SaveUrlOptions, type ServiceAccount } from "./save.js";

/// A small client for the Google Wallet REST API. Authenticates with the
///  service account JWT bearer grant and caches the access token until just
///  before it expires.

export const WALLET_API = "https://walletobjects.googleapis.com/walletobjects/v1";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

export class GoogleWalletApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`Google Wallet ${method} ${path} answered ${status}: ${body.slice(0, 500)}`);
    this.name = "GoogleWalletApiError";
    this.status = status;
    this.body = body;
  }
}

export interface GoogleWalletClientOptions {
  serviceAccount: ServiceAccount;
  /// The numeric issuer id from the Google Pay and Wallet Console.
  issuerId: string;
  fetch?: typeof fetch;
  /// Per call. Defaults to 10 seconds: these calls sit on manifest and push
  ///  paths, and fetch has no timeout of its own.
  timeoutMs?: number;
}

export interface GoogleMessage {
  header: string;
  body: string;
  /// Defaults to a time-based id.
  id?: string;
}

export interface GoogleWalletClient {
  readonly issuerId: string;
  accessToken(): Promise<string>;
  /// Raw call. Returns the status and parsed JSON (or null) without throwing
  ///  on a non-2xx answer.
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }>;
  /// The resource, or null on 404.
  get<T = GoogleResource>(type: GoogleResourceType, id: string): Promise<T | null>;
  insert<T = GoogleResource>(type: GoogleResourceType, resource: GoogleResource): Promise<T>;
  patch<T = GoogleResource>(type: GoogleResourceType, id: string, partial: Record<string, unknown>): Promise<T>;
  /// Get, then insert on 404 or patch when it exists. An insert that races
  ///  another writer (409) falls back to patch, because the loser of the race
  ///  may carry the newer content.
  upsert<T = GoogleResource>(type: GoogleResourceType, resource: GoogleResource): Promise<{ created: boolean; resource: T }>;
  addMessage(type: GoogleResourceType, id: string, message: GoogleMessage): Promise<void>;
  /// Sign a save link with this client's service account.
  saveUrl(opts: Omit<SaveUrlOptions, "serviceAccount">): Promise<string>;
}

/// Refresh a minute early, so a token never expires between the check and
///  the call.
const REFRESH_EARLY_MS = 60_000;

export function googleWalletClient(opts: GoogleWalletClientOptions): GoogleWalletClient {
  assertIssuerId(opts.issuerId);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sa = opts.serviceAccount;
  let cache: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const key = await importServiceAccountKey(sa.private_key);
    // Expiry is measured from BEFORE the request: Google's clock starts when
    // it issues the token, so stamping the arrival time would overstate the
    // token's life by the exchange latency.
    const requestedAtMs = Date.now();
    const now = Math.floor(requestedAtMs / 1000);
    const assertion = await new SignJWT({ scope: WALLET_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new GoogleWalletApiError("POST", "token", res.status, await res.text());
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      // Never cache, or send, "undefined" as a bearer token.
      throw new Error("Google token exchange answered without an access_token");
    }
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    cache = { token: body.access_token, expiresAtMs: requestedAtMs + ttl * 1000 };
    return body.access_token;
  }

  async function accessToken(): Promise<string> {
    if (cache && cache.expiresAtMs - REFRESH_EARLY_MS > Date.now()) return cache.token;
    // A burst on a cold cache shares one exchange.
    if (!inFlight) {
      inFlight = exchange().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function request(method: string, path: string, body?: unknown) {
    const token = await accessToken();
    const res = await doFetch(`${WALLET_API}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A rejected token (revoked or rotated key) is dropped at once, so it
    // costs one failed call rather than an hour of them. Only that token: a
    // newer one that already replaced it stays.
    if (res.status === 401 && cache?.token === token) cache = null;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  }

  const enc = encodeURIComponent;

  async function expectOk<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await request(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new GoogleWalletApiError(method, path, r.status, r.text);
    return r.body as T;
  }

  const client: GoogleWalletClient = {
    issuerId: opts.issuerId,
    accessToken,
    request,

    async get<T>(type: GoogleResourceType, id: string): Promise<T | null> {
      const path = `${type}/${enc(id)}`;
      const r = await request("GET", path);
      if (r.status === 404) return null;
      if (r.status < 200 || r.status >= 300) throw new GoogleWalletApiError("GET", path, r.status, r.text);
      return r.body as T;
    },

    insert<T>(type: GoogleResourceType, resource: GoogleResource): Promise<T> {
      return expectOk<T>("POST", type, resource);
    },

    patch<T>(type: GoogleResourceType, id: string, partial: Record<string, unknown>): Promise<T> {
      return expectOk<T>("PATCH", `${type}/${enc(id)}`, partial);
    },

    async upsert<T>(type: GoogleResourceType, resource: GoogleResource) {
      const existing = await client.get(type, resource.id);
      if (existing) return { created: false, resource: await client.patch<T>(type, resource.id, resource) };
      const r = await request("POST", type, resource);
      if (r.status === 409) return { created: false, resource: await client.patch<T>(type, resource.id, resource) };
      if (r.status < 200 || r.status >= 300) throw new GoogleWalletApiError("POST", type, r.status, r.text);
      return { created: true, resource: r.body as T };
    },

    async addMessage(type: GoogleResourceType, id: string, message: GoogleMessage): Promise<void> {
      await expectOk("POST", `${type}/${enc(id)}/addMessage`, {
        message: {
          id: message.id ?? `m-${Date.now().toString(36)}`,
          header: message.header,
          body: message.body,
          messageType: "TEXT",
        },
      });
    },

    saveUrl(saveOpts) {
      return createSaveUrl({ ...saveOpts, serviceAccount: sa });
    },
  };
  return client;
}
