import { underLimit } from "./kv";
import type { Runtime } from "./server";

/// The caller's IP as the host reports it. Only used to bucket rate limits.
export function clientIp(request: Request): string {
  return (request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
}

/// Daily caps for routes that spend the operator's gas. Without a shared
/// store (local mode) there is nothing to count against, so they pass.
export async function allowSpend(rt: Runtime, route: string, request: Request, perIp: number, perDay: number): Promise<boolean> {
  if (!rt.redis) return true;
  const day = 24 * 3600;
  const ip = clientIp(request);
  if (!(await underLimit(rt.redis, `${rt.prefix}limit:${route}:ip:${ip}`, perIp, day))) return false;
  return underLimit(rt.redis, `${rt.prefix}limit:${route}:all`, perDay, day);
}
