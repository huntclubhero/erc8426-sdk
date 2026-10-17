import { Redis } from "@upstash/redis";
import type { KeyValueStore } from "@erc8426/issuer";
import type { ApplePassRecord, ApplePassStore, DeviceRegistration } from "@erc8426/apple";
import { MAX_REGISTRATIONS_PER_PASS, SUPERSEDED_PUSH_WINDOW_MS } from "@erc8426/apple";
import type { GoogleObjectRecord, GoogleObjectStore } from "@erc8426/google";

/// Shared state for serverless hosting (Vercel and similar), where every
/// request may land on a different instance and in-memory stores would not
/// agree. One Upstash Redis (Vercel KV is Upstash) backs the issuer's nonces,
/// pass records and links, the Apple pass records and device registrations,
/// the Google object records, the operator lock and the rate limits.
///
/// Off unless UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the
/// KV_REST_API_* names the Vercel integration sets) are present.

export function redisFromEnv(env: NodeJS.ProcessEnv = process.env): Redis | null {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  // automaticDeserialization off: the stores write JSON strings and parse
  // them themselves. With it on, Upstash parses a stored JSON string into an
  // object on read, and kvStores would then JSON.parse an object.
  return new Redis({ url, token, automaticDeserialization: false });
}

/// The issuer's KeyValueStore on Upstash. GETDEL is atomic, which is what
/// keeps a nonce single-use across instances.
export function upstashKv(redis: Redis): KeyValueStore {
  return {
    get: (k) => redis.get<string>(k),
    async set(k, v, o = {}) {
      const opts: { ex?: number; nx?: true } = {};
      if (o.ttlSeconds) opts.ex = o.ttlSeconds;
      if (o.onlyIfAbsent) opts.nx = true;
      return (await redis.set(k, v, opts as never)) === "OK";
    },
    getDel: (k) => redis.getdel<string>(k),
    del: async (k) => void (await redis.del(k)),
  };
}

/// JSON that survives a round trip for the Apple record: Dates and byte
/// arrays (pass images) come back as what they were.
function encode(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key];
    if (raw instanceof Date) return { $date: raw.toISOString() };
    if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString("base64") };
    return v;
  });
}

function decode<T>(text: string | null): T | null {
  if (text === null) return null;
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (typeof v.$date === "string" && Object.keys(v).length === 1) return new Date(v.$date);
      if (typeof v.$bytes === "string" && Object.keys(v).length === 1) return new Uint8Array(Buffer.from(v.$bytes, "base64"));
    }
    return v;
  }) as T;
}

/// ApplePassStore on Redis: a record per serial, and registrations kept as
/// two sets (serials per device, push tokens per serial) plus one key per
/// registration. The LIVE devices of a pass are a list in registration order
/// (at most MAX_REGISTRATIONS_PER_PASS, never evicted); a rotation moves them
/// to a sorted set of superseded devices scored by when it happened.
export function redisApplePassStore(redis: Redis, prefix: string): ApplePassStore {
  const passKey = (serial: string) => `${prefix}apple:pass:${serial}`;
  const regKey = (d: string, t: string, s: string) => `${prefix}apple:reg:${d}:${t}:${s}`;
  const deviceKey = (d: string, t: string) => `${prefix}apple:device:${d}:${t}`;
  const serialKey = (t: string, s: string) => `${prefix}apple:serial:${t}:${s}`;
  const tokenKey = (pushToken: string) => `${prefix}apple:token:${pushToken}`;
  const recentKey = (t: string, s: string) => `${prefix}apple:recent:${t}:${s}`;
  const supersededKey = (t: string, s: string) => `${prefix}apple:superseded:${t}:${s}`;
  const tokensOf = async (devices: string[], t: string, s: string): Promise<string[]> => {
    const regs = await Promise.all(devices.map(async (d) => decode<DeviceRegistration>(await redis.get<string>(regKey(d, t, s)))));
    return regs.filter((r): r is DeviceRegistration => r !== null).map((r) => r.pushToken);
  };
  return {
    async getPass(serial) {
      return decode<ApplePassRecord>(await redis.get<string>(passKey(serial)));
    },
    async putPass(record) {
      await redis.set(passKey(record.serial), encode(record));
    },
    async register(r: DeviceRegistration) {
      const key = regKey(r.deviceLibraryIdentifier, r.passTypeIdentifier, r.serial);
      const live = recentKey(r.passTypeIdentifier, r.serial);
      const previous = decode<DeviceRegistration>(await redis.get<string>(key));
      const isLive = previous !== null && (await redis.lpos(live, r.deviceLibraryIdentifier)) !== null;
      // A new (or superseded) device at the cap is refused: nobody is evicted.
      if (!isLive && (await redis.llen(live)) >= MAX_REGISTRATIONS_PER_PASS) return "full" as const;
      const tx = redis.multi();
      tx.set(key, encode({ deviceLibraryIdentifier: r.deviceLibraryIdentifier, passTypeIdentifier: r.passTypeIdentifier, serial: r.serial, pushToken: r.pushToken }));
      tx.sadd(deviceKey(r.deviceLibraryIdentifier, r.passTypeIdentifier), r.serial);
      if (previous && previous.pushToken !== r.pushToken) {
        tx.srem(serialKey(r.passTypeIdentifier, r.serial), previous.pushToken);
      }
      tx.sadd(serialKey(r.passTypeIdentifier, r.serial), r.pushToken);
      tx.sadd(tokenKey(r.pushToken), key);
      if (!isLive) {
        tx.zrem(supersededKey(r.passTypeIdentifier, r.serial), r.deviceLibraryIdentifier);
        tx.rpush(live, r.deviceLibraryIdentifier);
      }
      await tx.exec();
      if (!isLive) {
        // Concurrent newcomers can all pass the length check: the first MAX in the
        // list keep their slot, and a later one withdraws.
        const pos = await redis.lpos(live, r.deviceLibraryIdentifier);
        if (pos !== null && pos >= MAX_REGISTRATIONS_PER_PASS) {
          await this.unregister(r.deviceLibraryIdentifier, r.passTypeIdentifier, r.serial);
          return "full" as const;
        }
      }
      return previous === null;
    },
    async supersede(passType, serial) {
      const live = recentKey(passType, serial);
      const devices = await redis.lrange<string>(live, 0, -1);
      if (devices.length === 0) return;
      const at = Date.now();
      const [first, ...rest] = devices.map((member) => ({ score: at, member }));
      const tx = redis.multi();
      tx.zadd(supersededKey(passType, serial), first!, ...rest);
      tx.del(live);
      await tx.exec();
    },
    async unregister(device, passType, serial) {
      const key = regKey(device, passType, serial);
      const previous = decode<DeviceRegistration>(await redis.get<string>(key));
      const tx = redis.multi();
      tx.del(key);
      tx.srem(deviceKey(device, passType), serial);
      tx.lrem(recentKey(passType, serial), 0, device);
      tx.zrem(supersededKey(passType, serial), device);
      if (previous) {
        tx.srem(serialKey(passType, serial), previous.pushToken);
        tx.srem(tokenKey(previous.pushToken), key);
      }
      await tx.exec();
    },
    async serialsForDevice(device, passType) {
      return redis.smembers(deviceKey(device, passType));
    },
    async pushTokensForSerial(passType, serial) {
      // Recently superseded devices first, then the live set (newest last).
      const recent = await redis.zrange<string[]>(supersededKey(passType, serial), Date.now() - SUPERSEDED_PUSH_WINDOW_MS, "+inf", { byScore: true });
      const live = await redis.lrange<string>(recentKey(passType, serial), 0, -1);
      return [...new Set([...(await tokensOf(recent.slice(-MAX_REGISTRATIONS_PER_PASS), passType, serial)), ...(await tokensOf(live, passType, serial))])];
    },
    async removePushToken(pushToken) {
      const keys = await redis.smembers(tokenKey(pushToken));
      for (const key of keys) {
        const r = decode<DeviceRegistration>(await redis.get<string>(key));
        if (r) await this.unregister(r.deviceLibraryIdentifier, r.passTypeIdentifier, r.serial);
      }
      await redis.del(tokenKey(pushToken));
    },
  };
}

export function redisGoogleObjectStore(redis: Redis, prefix: string): GoogleObjectStore {
  const key = (serial: string) => `${prefix}google:object:${serial}`;
  return {
    async get(serial) {
      return decode<GoogleObjectRecord>(await redis.get<string>(key(serial)));
    },
    async put(serial, record) {
      await redis.set(key(serial), encode(record));
    },
    async delete(serial) {
      await redis.del(key(serial));
    },
  };
}

/// Fixed-window counter. Returns false once `limit` hits were counted in the
/// current window for `key`.
export async function underLimit(redis: Redis, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const k = `${key}:${bucket}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSeconds + 60);
  return n <= limit;
}

/// A cross-instance mutex with a lease, so two instances never send operator
/// transactions with the same nonce. The lease outlives a stuck holder by at
/// most `leaseSeconds`.
export async function withLock<T>(redis: Redis, key: string, fn: () => Promise<T>, leaseSeconds = 60, waitMs = 45_000): Promise<T> {
  const owner = crypto.randomUUID();
  const start = Date.now();
  for (;;) {
    if ((await redis.set(key, owner, { nx: true, ex: leaseSeconds })) === "OK") break;
    if (Date.now() - start > waitMs) throw new Error("operator busy, try again in a moment");
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lease.
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [key], [owner]);
  }
}
