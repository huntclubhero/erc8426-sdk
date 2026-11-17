import { describe, expect, it } from "vitest";
import { IssuerConfigError, type ActionContext, type CreateIssuerOptions } from "@erc8426/issuer";

import { TOKEN_ID, buildHarness, claim, newSigner, proof, signChallenge, type Harness } from "./helpers.js";

/// A capability link minted for one subject (a proposal) and ended with it,
///  without replacing the pass. From Magicians t/29358 posts 27 to 29: a link
///  that carries the proposal only as a parameter casts the account's first
///  vote on every later proposal too.

interface Poll {
  /// The open proposal, or null.
  open: string | null;
  failing: boolean;
  votes: { proposal: string | undefined; path: string; params: unknown }[];
}

function harness(overrides: Partial<CreateIssuerOptions> = {}): Harness & { poll: Poll } {
  const poll: Poll = { open: null, failing: false, votes: [] };
  const vote = (ctx: ActionContext) => {
    poll.votes.push({ proposal: ctx.subject, path: ctx.path, params: ctx.params });
    return { ok: true };
  };
  const subject = () => {
    if (poll.failing) throw new Error("rpc unavailable");
    return poll.open;
  };
  // A subject has closed once it is no longer the open one: every node here is current.
  const subjectClosed = ({ subject }: { subject: string }) => {
    if (poll.failing) throw new Error("rpc unavailable");
    return subject !== poll.open;
  };
  const h = buildHarness({
    actions: {
      "vote-yes": { description: "Vote yes", capability: true, bound: "One vote per proposal, enforced elsewhere", subject, subjectClosed, execute: vote },
      feed: { description: "Feed", capability: true, bound: "Idempotent", execute: () => ({ fed: true }) },
    },
    ...overrides,
  });
  return { ...h, poll };
}

const linksOf = async (h: Harness): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [action, u] of Object.entries(await h.issuer.capabilityLinksFor(TOKEN_ID))) out[action] = new URL(u).pathname;
  return out;
};
const recordOf = (h: Harness) => h.issuer.stores.passes.get(TOKEN_ID);

async function issued(h: Harness) {
  const owner = newSigner();
  h.chain.setOwner(TOKEN_ID, owner.address);
  const first = await claim(h, owner);
  expect(first.res.status).toBe(200);
  return { owner, first };
}

describe("a capability link with a subject", () => {
  it("is not minted while nothing is open, and the other links are", async () => {
    const h = harness();
    await issued(h);
    const links = await linksOf(h);
    expect(links["vote-yes"]).toBeUndefined();
    expect(links.feed).toBeDefined();
    expect((await recordOf(h))!.linkSubjects).toBeUndefined();
  });

  it("is minted for the open subject, acts on that subject from the issuer's record, and ignores what the request names", async () => {
    const h = harness();
    await issued(h);
    h.poll.open = "5";
    const links = await linksOf(h);
    expect(links["vote-yes"]).toBeDefined();
    expect((await recordOf(h))!.linkSubjects).toEqual({ "vote-yes": "5" });
    // The same link on every render while the subject stays open.
    expect((await linksOf(h))["vote-yes"]).toBe(links["vote-yes"]);
    const res = await h.post(`${links["vote-yes"]}?p=6`, { params: { proposalId: "6", subject: "6" } });
    expect(res.status).toBe(200);
    expect(h.poll.votes).toEqual([{ proposal: "5", path: "capability", params: { proposalId: "6", subject: "6" } }]);
  });

  it("ends with its subject: the link seen during one proposal does nothing on the next", async () => {
    const h = harness();
    await issued(h);
    h.poll.open = "5";
    const during5 = await linksOf(h);
    const before = (await recordOf(h))!;
    const feed = during5.feed!;
    // Proposal 5 closes and proposal 6 opens. Nobody has rendered the pass.
    h.poll.open = "6";
    const late = await h.post(during5["vote-yes"]!, {});
    expect(late.status).toBe(404);
    expect(((await late.json()) as { error: string }).error).toBe("unknown_capability");
    expect(h.poll.votes).toEqual([]);
    // Pointing the old link at the new proposal changes nothing.
    expect((await h.post(`${during5["vote-yes"]}?p=6`, { params: { proposalId: "6" } })).status).toBe(404);
    // Not a rotation: the same card, the same other links, the same downloads.
    const after = (await recordOf(h))!;
    expect(after.serial).toBe(before.serial);
    expect(after.generation).toBe(before.generation);
    expect(after.downloads).toEqual(before.downloads);
    expect(after.links.feed).toBe(before.links.feed);
    expect((await h.post(feed, {})).status).toBe(200);
    // The pass gets a link for proposal 6, and it votes on 6.
    const during6 = await linksOf(h);
    expect(during6["vote-yes"]).toBeDefined();
    expect(during6["vote-yes"]).not.toBe(during5["vote-yes"]);
    expect((await h.post(during6["vote-yes"]!, {})).status).toBe(200);
    expect(h.poll.votes.map((v) => v.proposal)).toEqual(["6"]);
  });

  it("ends when its subject closes with nothing open after it", async () => {
    const h = harness();
    await issued(h);
    h.poll.open = "5";
    const links = await linksOf(h);
    h.poll.open = null;
    expect((await h.post(links["vote-yes"]!, {})).status).toBe(404);
    expect((await linksOf(h))["vote-yes"]).toBeUndefined();
    const record = (await recordOf(h))!;
    expect(record.links["vote-yes"]).toBeUndefined();
    expect(record.linkSubjects).toBeUndefined();
    // The same proposal id opening again does not wake the old link.
    h.poll.open = "5";
    expect((await h.post(links["vote-yes"]!, {})).status).toBe(404);
    expect((await linksOf(h))["vote-yes"]).not.toBe(links["vote-yes"]);
  });

  it("renders the pass with the link of the open subject, and pushes it to the same installed pass", async () => {
    const h = harness();
    await issued(h);
    const serial = (await recordOf(h))!.serial;
    h.poll.open = "5";
    await h.issuer.onPassUpdate(TOKEN_ID);
    const pushed5 = h.notified.at(-1)!.ctx.content;
    expect(pushed5.serial).toBe(serial);
    const link5 = pushed5.links!.find((l) => l.key === "vote-yes")!.url;
    h.poll.open = "6";
    await h.issuer.onPassUpdate(TOKEN_ID);
    const pushed6 = h.notified.at(-1)!.ctx.content;
    expect(pushed6.serial).toBe(serial);
    expect(pushed6.voided).toBeUndefined();
    const link6 = pushed6.links!.find((l) => l.key === "vote-yes")!.url;
    expect(link6).not.toBe(link5);
    expect((await h.post(new URL(link5).pathname, {})).status).toBe(404);
    expect((await h.post(new URL(link6).pathname, {})).status).toBe(200);
  });

  it("tells the confirm page what the link is for, with no read", async () => {
    const seen: (string | undefined)[] = [];
    const h = harness({
      capability: {
        enabled: true,
        confirmPage: (ctx) => {
          seen.push(ctx.subject);
          return new Response("ok");
        },
      },
    });
    await issued(h);
    h.poll.open = "5";
    const links = await linksOf(h);
    const reads = h.chain.reads;
    await h.get(links["vote-yes"]!);
    await h.get(links.feed!);
    expect(seen).toEqual(["5", undefined]);
    expect(h.chain.reads).toBe(reads);
  });

  it("when the subject cannot be told: the link is left as it is, a use answers 503, a render leaves it out", async () => {
    const h = harness();
    await issued(h);
    h.poll.open = "5";
    const links = await linksOf(h);
    h.poll.failing = true;
    const res = await h.post(links["vote-yes"]!, {});
    expect(res.status).toBe(503);
    expect((await linksOf(h))["vote-yes"]).toBeUndefined();
    expect((await linksOf(h)).feed).toBe(links.feed);
    h.poll.failing = false;
    expect((await linksOf(h))["vote-yes"]).toBe(links["vote-yes"]);
    expect((await h.post(links["vote-yes"]!, {})).status).toBe(200);
  });

  it("a rotation retires it like any other link, and the next one is minted for the open subject", async () => {
    const h = harness();
    const { owner } = await issued(h);
    h.poll.open = "5";
    const links = await linksOf(h);
    await h.issuer.rotate(TOKEN_ID);
    expect((await h.post(links["vote-yes"]!, {})).status).toBe(404);
    expect((await claim(h, owner)).res.status).toBe(200);
    const fresh = await linksOf(h);
    expect(fresh["vote-yes"]).toBeDefined();
    expect(fresh["vote-yes"]).not.toBe(links["vote-yes"]);
    expect((await h.post(fresh["vote-yes"]!, {})).status).toBe(200);
    expect(h.poll.votes.map((v) => v.proposal)).toEqual(["5"]);
  });

  it("the signed path carries no subject: the request names what it concerns", async () => {
    const h = harness();
    const { owner } = await issued(h);
    h.poll.open = "5";
    const p = await signChallenge(h, owner, TOKEN_ID, "vote-yes");
    const res = await h.post(`/wallet-pass/${TOKEN_ID}/actions/vote-yes`, { params: { proposalId: "5" } }, proof(p));
    expect(res.status).toBe(200);
    expect(h.poll.votes).toEqual([{ proposal: undefined, path: "signed", params: { proposalId: "5" } }]);
  });

  it("refuses a subject on an action that has no capability link, and a subject that is not a function", () => {
    const execute = () => ({ ok: true });
    expect(() => buildHarness({ actions: { a: { description: "A", subject: () => "1", subjectClosed: () => false, execute } } })).toThrow(IssuerConfigError);
    expect(() => buildHarness({ actions: { a: { description: "A", capability: true, bound: "b", subject: "1" as never, execute } } })).toThrow(/subject must be a function/);
    // What ends a link is that its own subject has closed, so a subject needs the function that says so.
    expect(() => buildHarness({ actions: { a: { description: "A", capability: true, bound: "b", subject: () => "1", execute } } })).toThrow(/has a subject but no subjectClosed/);
    expect(() => buildHarness({ actions: { a: { description: "A", capability: true, bound: "b", subjectClosed: () => false, execute } } })).toThrow(/has subjectClosed but no subject/);
    expect(() => buildHarness({ actions: { a: { description: "A", capability: true, bound: "b", subject: () => "1", subjectClosed: true as never, execute } } })).toThrow(/subjectClosed must be a function/);
  });
});
