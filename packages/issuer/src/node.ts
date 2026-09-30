import { MAX_BODY_BYTES } from "./http.js";
import type { Issuer } from "./issuer.js";

/// Node and Express adapters for the fetch handler, typed structurally so
///  this package never imports `node:http` or `express` at runtime.

/// The parts of `http.IncomingMessage` (or an Express request) the adapter
///  reads.
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  /// Set by Express; preserves the mount path that `url` has stripped.
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /// Set when a body parser (express.json(), express.urlencoded()) already
  ///  consumed the stream.
  body?: unknown;
}

/// The parts of `http.ServerResponse` the adapter writes.
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(chunk?: Uint8Array | string): unknown;
}

export type FetchHandler = (request: Request) => Promise<Response>;
export type RouteHandler = (request: Request) => Promise<Response | null>;

// Hop-by-hop and connection headers a fetch Request must not carry.
const SKIP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "expect", "host"]);

/// Convert a Node request into a WHATWG Request. The origin is only used to
///  build a parseable URL: the issuer builds every absolute URL it emits from
///  its configured baseUrl, never from the request's Host.
///
///  The body is read with a running byte count and never buffered past
///  `maxBodyBytes + 1`: an oversized body is cut there, which the issuer's
///  handler then refuses as too large, so an anonymous client cannot make
///  the adapter hold an unbounded body in memory.
export async function toFetchRequest(req: NodeRequestLike, origin = "http://localhost", maxBodyBytes = MAX_BODY_BYTES): Promise<Request> {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":") || SKIP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = new URL(req.originalUrl ?? req.url ?? "/", origin);
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });

  let body: string | Uint8Array<ArrayBuffer>;
  if (req.body !== undefined && req.body !== null && !(req.body instanceof Uint8Array) && typeof req.body === "object") {
    // A body parser already consumed the stream: re-serialize what it parsed.
    body = JSON.stringify(req.body);
    headers.set("Content-Type", "application/json");
  } else if (typeof req.body === "string" || req.body instanceof Uint8Array) {
    body = typeof req.body === "string" ? req.body : new Uint8Array(req.body);
  } else {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const raw of req) {
      let chunk = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
      if (total + chunk.length > maxBodyBytes + 1) chunk = chunk.subarray(0, maxBodyBytes + 1 - total);
      chunks.push(chunk);
      total += chunk.length;
      // Leaving the loop stops pulling from the socket.
      if (total > maxBodyBytes) break;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    body = joined;
  }
  return new Request(url, { method, headers, body });
}

/// Write a WHATWG Response to a Node response.
export async function sendFetchResponse(res: NodeResponseLike, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  const buf = new Uint8Array(await response.arrayBuffer());
  res.end(buf.length > 0 ? buf : undefined);
}

/// A `(req, res)` listener for `http.createServer`, from an issuer or any
///  fetch handler. Unexpected errors answer 500 rather than hanging.
export function toNodeHandler(target: Issuer | FetchHandler, options: { origin?: string } = {}) {
  const handler: FetchHandler = typeof target === "function" ? target : (r) => target.handler(r);
  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    try {
      await sendFetchResponse(res, await handler(await toFetchRequest(req, options.origin)));
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  };
}

/// Express (or Connect) middleware: serves paths under the issuer's basePath
///  and calls `next()` for everything else. Mount it at the app root
///  (`app.use(expressMiddleware(issuer))`); it works with or without
///  express.json() ahead of it.
export function expressMiddleware(issuer: Issuer | { route: RouteHandler }, options: { origin?: string } = {}) {
  return (req: NodeRequestLike, res: NodeResponseLike, next: (error?: unknown) => void): void => {
    void (async () => {
      const response = await issuer.route(await toFetchRequest(req, options.origin));
      if (response === null) return next();
      await sendFetchResponse(res, response);
    })().catch(next);
  };
}
