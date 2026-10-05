import { describe, expect, it } from "vitest";
import { appleFormatProvider } from "@erc8426/apple";

import { makeTestCerts, TINY_PNG, unzip } from "../../packages/apple/test/helpers.js";
import { googleProvider } from "../e2e/harness.js";
import { BASE, TOKEN_ID, buildHarness, issuePassTo, newSigner, signChallenge } from "../../packages/issuer/test/helpers.js";

const ROTATE = `/wallet-pass/${TOKEN_ID}/rotate`;
const PASS_TYPE = "pass.example.audit";

describe("AUDIT wallets: owner-requested rotation (the remedy for a leaked link)", () => {
  it("Apple: a forwarded copy of the pass keeps refreshing after rotation and receives the fresh capability links", async () => {
    const apple = appleFormatProvider({
      passTypeIdentifier: PASS_TYPE,
      teamIdentifier: "AUDITTEAM1",
      certificates: makeTestCerts({ passTypeId: PASS_TYPE, teamId: "AUDITTEAM1" }),
      origin: BASE,
      images: { icon: { data: TINY_PNG } },
    });
    const h = buildHarness({ providers: [apple] });
    const owner = newSigner();
    await issuePassTo(h, owner);

    // The owner downloads the pass; a copy leaks (AirDrop, backup, email).
    const record = (await h.issuer.stores.passes.get(TOKEN_ID))!;
    const dl = await h.get(`/wallet-pass/passes/${record.downloads.apple}`);
    expect(dl.status).toBe(200);
    const leaked = JSON.parse(unzip(new Uint8Array(await dl.arrayBuffer()))["pass.json"]!.toString("utf8")) as {
      serialNumber: string;
      authenticationToken: string;
    };

    // The owner notices and rotates, as the spec's only remedy.
    const p = await signChallenge(h, owner, TOKEN_ID, "rotate");
    expect((await h.post(ROTATE, p)).status).toBe(200);
    const freshFeed = (await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!;

    // The leaked copy asks the PassKit web service for the latest pass with
    // the token it carries.
    const refresh = await apple.handle(
      new Request(`${BASE}/apple/v1/passes/${PASS_TYPE}/${leaked.serialNumber}`, {
        headers: { Authorization: `ApplePass ${leaked.authenticationToken}` },
      }),
    );
    const refreshedJson = refresh.status === 200 ? unzip(new Uint8Array(await refresh.arrayBuffer()))["pass.json"]!.toString("utf8") : "";
    // A rotation that is a remedy must not deliver the new link to the leaked copy.
    expect({ status: refresh.status, carriesFreshLink: refreshedJson.includes(freshFeed) }).toEqual({
      status: refresh.status,
      carriesFreshLink: false,
    });
  });

  it("Google: the saved object keeps its id after rotation and is PATCHed with the fresh capability links", async () => {
    const { provider, api } = googleProvider(BASE);
    const h = buildHarness({ providers: [provider] });
    const owner = newSigner();
    await issuePassTo(h, owner);
    const objectKeys = [...api.resources.keys()].filter((k) => k.includes("Object/"));
    expect(objectKeys).toHaveLength(1);
    const leakedObject = objectKeys[0]!;

    const p = await signChallenge(h, owner, TOKEN_ID, "rotate");
    expect((await h.post(ROTATE, p)).status).toBe(200);
    const freshFeed = (await h.issuer.capabilityLinksFor(TOKEN_ID)).feed!;

    // Everyone who saved the leaked save link holds this same object.
    const obj = api.resources.get(leakedObject) as Record<string, unknown>;
    const carriesFreshLink = JSON.stringify(obj).includes(freshFeed);
    expect({ state: obj.state, carriesFreshLink }).toEqual({ state: "EXPIRED", carriesFreshLink: false });
  });
});
