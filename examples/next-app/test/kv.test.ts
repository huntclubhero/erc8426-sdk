import type { Redis } from "@upstash/redis";
import { MAX_REGISTRATIONS_PER_PASS, MAX_PUSH_TOKENS_PER_PASS, SUPERSEDED_PUSH_WINDOW_MS, type DeviceRegistration } from "@erc8426/apple";
import { describe, expect, it } from "vitest";

import { redisApplePassStore } from "../lib/kv";

/// An in-memory stand-in for the Upstash client, covering exactly the commands
/// the Redis Apple store uses. Every command is synchronous under the hood and
/// multi().exec() runs its queue without yielding, so a transaction is atomic
/// against the other callers of a test, as MULTI/EXEC is on a server.
class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly lists = new Map<string, string[]>();
  readonly zsets = new Map<string, Map<string, number>>();

  // Synchronous core.
  private set_(k: string, v: unknown, opts?: { nx?: boolean }): "OK" | null {
    if (opts?.nx && this.strings.has(k)) return null;
    this.strings.set(k, String(v));
    return "OK";
  }
  private del_(...keys: string[]): number {
    let n = 0;
    for (const k of keys) for (const m of [this.strings, this.sets, this.lists, this.zsets]) if (m.delete(k)) n += 1;
    return n;
  }
  private sadd_(k: string, ...members: string[]): number {
    const s = this.sets.get(k) ?? new Set<string>();
    const before = s.size;
    for (const m of members) s.add(String(m));
    this.sets.set(k, s);
    return s.size - before;
  }
  private srem_(k: string, ...members: string[]): number {
    const s = this.sets.get(k);
    if (!s) return 0;
    let n = 0;
    for (const m of members) if (s.delete(String(m))) n += 1;
    if (s.size === 0) this.sets.delete(k);
    return n;
  }
  private rpush_(k: string, ...values: string[]): number {
    const l = this.lists.get(k) ?? [];
    l.push(...values.map(String));
    this.lists.set(k, l);
    return l.length;
  }
  private lrem_(k: string, count: number, value: string): number {
    const l = this.lists.get(k);
    if (!l) return 0;
    let removed = 0;
    if (count === 0) {
      const kept = l.filter((v) => v !== value);
      removed = l.length - kept.length;
      this.lists.set(k, kept);
    } else if (count > 0) {
      for (let i = 0; i < l.length && removed < count; ) {
        if (l[i] === value) {
          l.splice(i, 1);
          removed += 1;
        } else i += 1;
      }
    } else {
      for (let i = l.length - 1; i >= 0 && removed < -count; i -= 1) {
        if (l[i] === value) {
          l.splice(i, 1);
          removed += 1;
        }
      }
    }
    if ((this.lists.get(k) ?? []).length === 0) this.lists.delete(k);
    return removed;
  }
  private zadd_(k: string, ...entries: Array<{ score: number; member: string }>): number {
    const z = this.zsets.get(k) ?? new Map<string, number>();
    let added = 0;
    for (const e of entries) {
      if (!z.has(e.member)) added += 1;
      z.set(e.member, e.score);
    }
    this.zsets.set(k, z);
    return added;
  }
  private zrem_(k: string, ...members: string[]): number {
    const z = this.zsets.get(k);
    if (!z) return 0;
    let n = 0;
    for (const m of members) if (z.delete(m)) n += 1;
    if (z.size === 0) this.zsets.delete(k);
    return n;
  }

  // The async surface kv.ts calls.
  async get(k: string): Promise<string | null> {
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: unknown, opts?: { nx?: boolean }): Promise<"OK" | null> {
    return this.set_(k, v, opts);
  }
  async del(...keys: string[]): Promise<number> {
    return this.del_(...keys);
  }
  async sadd(k: string, ...members: string[]): Promise<number> {
    return this.sadd_(k, ...members);
  }
  async srem(k: string, ...members: string[]): Promise<number> {
    return this.srem_(k, ...members);
  }
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? [])];
  }
  async rpush(k: string, ...values: string[]): Promise<number> {
    return this.rpush_(k, ...values);
  }
  async lpos(k: string, value: string): Promise<number | null> {
    const i = (this.lists.get(k) ?? []).indexOf(value);
    return i < 0 ? null : i;
  }
  async llen(k: string): Promise<number> {
    return (this.lists.get(k) ?? []).length;
  }
  async lrange(k: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(k) ?? [];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }
  async lrem(k: string, count: number, value: string): Promise<number> {
    return this.lrem_(k, count, value);
  }
  async zadd(k: string, ...entries: Array<{ score: number; member: string }>): Promise<number> {
    return this.zadd_(k, ...entries);
  }
  async zrem(k: string, ...members: string[]): Promise<number> {
    return this.zrem_(k, ...members);
  }
  async zscore(k: string, member: string): Promise<number | null> {
    return this.zsets.get(k)?.get(member) ?? null;
  }
  async zrange(k: string, min: number | string, max: number | string, opts?: { byScore?: boolean }): Promise<string[]> {
    const z = this.zsets.get(k) ?? new Map<string, number>();
    const entries = [...z.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    if (!opts?.byScore) throw new Error("fake zrange supports byScore only");
    const bound = (v: number | string, fallback: number) => (v === "-inf" ? -Infinity : v === "+inf" ? Infinity : typeof v === "number" ? v : fallback);
    const lo = bound(min, -Infinity);
    const hi = bound(max, Infinity);
    return entries.filter(([, score]) => score >= lo && score <= hi).map(([m]) => m);
  }
  /// The only script the store runs is CLAIM_SLOT; it is emulated here, atomically.
  async eval(script: string, keys: string[], args: string[]): Promise<string> {
    if (!script.includes("RPUSH")) throw new Error("fake eval knows CLAIM_SLOT only");
    const [live] = keys as [string];
    const [device, cap, needsSlot] = args as [string, string, string];
    const l = this.lists.get(live) ?? [];
    if (l.includes(device)) return "live";
    if (needsSlot === "1" && l.length >= Number(cap)) return "full";
    this.rpush_(live, device);
    return "added";
  }
  multi() {
    const queue: Array<() => unknown> = [];
    const tx = {
      set: (k: string, v: unknown, o?: { nx?: boolean }) => (queue.push(() => this.set_(k, v, o)), tx),
      del: (...keys: string[]) => (queue.push(() => this.del_(...keys)), tx),
      sadd: (k: string, ...m: string[]) => (queue.push(() => this.sadd_(k, ...m)), tx),
      srem: (k: string, ...m: string[]) => (queue.push(() => this.srem_(k, ...m)), tx),
      rpush: (k: string, ...v: string[]) => (queue.push(() => this.rpush_(k, ...v)), tx),
      lrem: (k: string, c: number, v: string) => (queue.push(() => this.lrem_(k, c, v)), tx),
      zadd: (k: string, ...e: Array<{ score: number; member: string }>) => (queue.push(() => this.zadd_(k, ...e)), tx),
      zrem: (k: string, ...m: string[]) => (queue.push(() => this.zrem_(k, ...m)), tx),
      exec: async (): Promise<unknown[]> => queue.map((q) => q()),
    };
    return tx;
  }
}

const PASS_TYPE = "pass.example.test";
const PREFIX = "t:";
const tok = (i: number) => i.toString(16).padStart(64, "0");
const reg = (device: string, pushToken: string, serial = "one"): DeviceRegistration => ({ deviceLibraryIdentifier: device, passTypeIdentifier: PASS_TYPE, serial, pushToken });

function setup() {
  const redis = new FakeRedis();
  const store = redisApplePassStore(redis as unknown as Redis, PREFIX);
  const liveList = (serial = "one") => redis.lists.get(`${PREFIX}apple:recent:${PASS_TYPE}:${serial}`) ?? [];
  const perSerialTokens = (serial = "one") => [...(redis.sets.get(`${PREFIX}apple:serial:${PASS_TYPE}:${serial}`) ?? [])];
  const supersededScore = (device: string, serial = "one") => redis.zsets.get(`${PREFIX}apple:superseded:${PASS_TYPE}:${serial}`)?.get(device) ?? null;
  /// Write a registration the way the 0.2.0 store did: the row, the per-device
  /// serial set, the per-serial token set and the per-token index. No live
  /// list, no superseded set.
  const seedLegacy = (device: string, pushToken: string, serial = "one") => {
    const key = `${PREFIX}apple:reg:${device}:${PASS_TYPE}:${serial}`;
    redis.strings.set(key, JSON.stringify(reg(device, pushToken, serial)));
    redis.sets.set(`${PREFIX}apple:device:${device}:${PASS_TYPE}`, new Set([...(redis.sets.get(`${PREFIX}apple:device:${device}:${PASS_TYPE}`) ?? []), serial]));
    const s = redis.sets.get(`${PREFIX}apple:serial:${PASS_TYPE}:${serial}`) ?? new Set<string>();
    s.add(pushToken);
    redis.sets.set(`${PREFIX}apple:serial:${PASS_TYPE}:${serial}`, s);
    redis.sets.set(`${PREFIX}apple:token:${pushToken}`, new Set([key]));
  };
  const fill = async (n = MAX_REGISTRATIONS_PER_PASS, serial = "one") => {
    for (let i = 0; i < n; i++) expect(await store.register(reg(`dev${i}`, tok(i), serial))).toBe(true);
  };
  return { redis, store, liveList, perSerialTokens, supersededScore, seedLegacy, fill };
}

async function atLaterTime<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

describe("redisApplePassStore (Upstash fake)", () => {
  it("refuses a newcomer at the cap and evicts nobody", async () => {
    const { store, fill, liveList } = setup();
    await fill();
    expect(await store.register(reg("intruder", tok(100)))).toBe("full");
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    const pushed = await store.pushTokensForSerial(PASS_TYPE, "one");
    expect(pushed).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(pushed).toContain(tok(0));
    expect(pushed).not.toContain(tok(100));
    // The refused device left nothing behind.
    expect(await store.serialsForDevice("intruder", PASS_TYPE)).toEqual([]);
    // Another serial is capped on its own.
    expect(await store.register(reg("b0", tok(500), "two"))).toBe(true);
    expect(await store.pushTokensForSerial(PASS_TYPE, "two")).toEqual([tok(500)]);
  });

  it("a live device re-registering at the cap keeps its slot and rotates its token", async () => {
    const { store, fill, liveList, perSerialTokens } = setup();
    await fill();
    expect(await store.register(reg("dev3", tok(900)))).toBe(false);
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(liveList().filter((d) => d === "dev3")).toHaveLength(1);
    const pushed = await store.pushTokensForSerial(PASS_TYPE, "one");
    expect(pushed).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(pushed).toContain(tok(900));
    expect(pushed).not.toContain(tok(3));
    // The per-serial token set follows the token (A6).
    expect(perSerialTokens()).toContain(tok(900));
    expect(perSerialTokens()).not.toContain(tok(3));
    await store.unregister("dev3", PASS_TYPE, "one");
    expect(perSerialTokens()).not.toContain(tok(900));
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS - 1);
  });

  it("supersede frees the slots; superseded devices stay listed and pushed within the window, not after", async () => {
    const { store, fill, liveList } = setup();
    await fill();
    expect(await store.register(reg("new0", tok(50)))).toBe("full");
    await store.supersede(PASS_TYPE, "one");
    expect(liveList()).toEqual([]);
    expect(await store.register(reg("new0", tok(50)))).toBe(true);
    expect(await store.serialsForDevice("dev0", PASS_TYPE)).toEqual(["one"]);
    const pushed = await store.pushTokensForSerial(PASS_TYPE, "one");
    expect(pushed).toContain(tok(0));
    expect(pushed).toContain(tok(50));
    expect(pushed.at(-1)).toBe(tok(50));
    expect(pushed.length).toBeLessThanOrEqual(MAX_PUSH_TOKENS_PER_PASS);
    // A superseded device that adds the current pass rejoins the live set.
    expect(await store.register(reg("dev0", tok(60)))).toBe(false);
    expect(liveList()).toEqual(["new0", "dev0"]);
    // Past the window the superseded rows stop receiving pushes but still answer the list call.
    await atLaterTime(SUPERSEDED_PUSH_WINDOW_MS + 1000, async () => {
      const later = await store.pushTokensForSerial(PASS_TYPE, "one");
      expect(later.sort()).toEqual([tok(50), tok(60)].sort());
      expect(await store.serialsForDevice("dev1", PASS_TYPE)).toEqual(["one"]);
    });
    // supersede on an empty live list is a no-op.
    await store.supersede(PASS_TYPE, "nothing");
  });

  it("a legacy (0.2.0-shaped) registration keeps receiving pushes and keeps its slot on re-register", async () => {
    const { store, seedLegacy, liveList, perSerialTokens } = setup();
    seedLegacy("old0", tok(0));
    seedLegacy("old1", tok(1));
    // No live list, no superseded set: the tokens still come from the per-serial set.
    expect(liveList()).toEqual([]);
    expect((await store.pushTokensForSerial(PASS_TYPE, "one")).sort()).toEqual([tok(0), tok(1)].sort());
    expect(await store.serialsForDevice("old0", PASS_TYPE)).toEqual(["one"]);
    // Newcomers fill the cap next to the legacy rows.
    for (let i = 0; i < MAX_REGISTRATIONS_PER_PASS; i++) expect(await store.register(reg(`new${i}`, tok(100 + i)))).toBe(true);
    expect(await store.register(reg("intruder", tok(999)))).toBe("full");
    // A legacy device re-registering at the cap is not refused: it joins the live list.
    expect(await store.register(reg("old0", tok(10)))).toBe(false);
    expect(liveList()).toContain("old0");
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS + 1);
    // And it counts once, with its new token; the one still untouched keeps its old token.
    const pushed = await store.pushTokensForSerial(PASS_TYPE, "one");
    expect(pushed.filter((t) => t === tok(10))).toHaveLength(1);
    expect(pushed).not.toContain(tok(0));
    expect(pushed).toContain(tok(1));
    expect(pushed).toHaveLength(MAX_REGISTRATIONS_PER_PASS + 2);
    expect(perSerialTokens()).not.toContain(tok(0));
    // Re-registering again is the ordinary live path.
    expect(await store.register(reg("old0", tok(11)))).toBe(false);
    expect(liveList().filter((d) => d === "old0")).toHaveLength(1);
    // An APNs 410 for a legacy token removes the legacy row like any other.
    await store.removePushToken(tok(1));
    expect(await store.pushTokensForSerial(PASS_TYPE, "one")).not.toContain(tok(1));
    expect(await store.serialsForDevice("old1", PASS_TYPE)).toEqual([]);
  });

  it("a superseded device past the push window is not revived through the legacy path", async () => {
    const { store, fill } = setup();
    await fill(2);
    await store.supersede(PASS_TYPE, "one");
    await atLaterTime(SUPERSEDED_PUSH_WINDOW_MS + 1000, async () => {
      expect(await store.pushTokensForSerial(PASS_TYPE, "one")).toEqual([]);
    });
  });

  it("a superseded device that loses the race for the last slot stays superseded, nothing deleted (A4)", async () => {
    const { store, fill, liveList, supersededScore, perSerialTokens } = setup();
    await fill(2);
    await atLaterTime(-60_000, () => store.supersede(PASS_TYPE, "one"));
    const oldScore = supersededScore("dev1");
    expect(oldScore).not.toBeNull();
    // Nine newcomers, one slot left; the two superseded devices race for it.
    for (let i = 0; i < MAX_REGISTRATIONS_PER_PASS - 1; i++) expect(await store.register(reg(`new${i}`, tok(100 + i)))).toBe(true);
    const [a, b] = await Promise.all([store.register(reg("dev0", tok(70))), store.register(reg("dev1", tok(71)))]);
    expect([a, b].filter((x) => x === "full")).toHaveLength(1);
    expect([a, b].filter((x) => x === false)).toHaveLength(1);
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    const loser = a === "full" ? "dev0" : "dev1";
    const loserOld = loser === "dev0" ? tok(0) : tok(1);
    const loserNew = loser === "dev0" ? tok(70) : tok(71);
    // Untouched: still superseded with its old score and old token, still listed, still pushed.
    expect(liveList()).not.toContain(loser);
    expect(supersededScore(loser)).toBe(oldScore);
    expect(await store.serialsForDevice(loser, PASS_TYPE)).toEqual(["one"]);
    const pushed = await store.pushTokensForSerial(PASS_TYPE, "one");
    expect(pushed).toContain(loserOld);
    expect(pushed).not.toContain(loserNew);
    expect(perSerialTokens()).toContain(loserOld);
    expect(perSerialTokens()).not.toContain(loserNew);
    // It is still refused while the pass is full, and admitted once a slot frees.
    expect(await store.register(reg(loser, loserNew))).toBe("full");
    await store.unregister("new0", PASS_TYPE, "one");
    expect(await store.register(reg(loser, loserNew))).toBe(false);
    expect(supersededScore(loser)).toBeNull();
  });

  it("a double-register of the same new device lands once in the live list (A5)", async () => {
    const { store, liveList } = setup();
    const results = await Promise.all([store.register(reg("twin", tok(1))), store.register(reg("twin", tok(1))), store.register(reg("twin", tok(1)))]);
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(2);
    expect(liveList()).toEqual(["twin"]);
    expect(await store.pushTokensForSerial(PASS_TYPE, "one")).toEqual([tok(1)]);
    // A twin at the cap: one is refused, the other is kept exactly once.
    for (let i = 0; i < MAX_REGISTRATIONS_PER_PASS - 2; i++) expect(await store.register(reg(`d${i}`, tok(10 + i)))).toBe(true);
    const race = await Promise.all([store.register(reg("last", tok(90))), store.register(reg("last", tok(90))), store.register(reg("other", tok(91)))]);
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(liveList().filter((d) => d === "last")).toHaveLength(1);
    expect(race.filter((r) => r === "full")).toHaveLength(1);
    expect(liveList()).not.toContain("other");
    expect(await store.serialsForDevice("other", PASS_TYPE)).toEqual([]);
  });

  it("concurrent newcomers never exceed the cap", async () => {
    const { store, liveList } = setup();
    const results = await Promise.all(Array.from({ length: MAX_REGISTRATIONS_PER_PASS + 5 }, (_, i) => store.register(reg(`c${i}`, tok(i)))));
    expect(results.filter((r) => r === "full")).toHaveLength(5);
    expect(liveList()).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    expect(await store.pushTokensForSerial(PASS_TYPE, "one")).toHaveLength(MAX_REGISTRATIONS_PER_PASS);
    for (const d of liveList()) expect(await store.serialsForDevice(d, PASS_TYPE)).toEqual(["one"]);
    const refused = Array.from({ length: MAX_REGISTRATIONS_PER_PASS + 5 }, (_, i) => `c${i}`).filter((d) => !liveList().includes(d));
    for (const d of refused) expect(await store.serialsForDevice(d, PASS_TYPE)).toEqual([]);
  });
});
