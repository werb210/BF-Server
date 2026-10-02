// BF_SERVER_ADS_AUDIENCES_v708
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { buildAudienceBody, audienceLists, DATA_MANAGER_AUDIENCE_URL } from "../services/googleAudienceSync.js";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("Customer Match through Data Manager", () => {
  it("uses the Data Manager audience endpoint, hashed identifiers, consent and the terms of service", () => {
    process.env.GOOGLE_ADS_CUSTOMER_ID = "258-685-7341";
    const body = buildAudienceBody("123", [[{ hashedEmail: "ab" }, { hashedPhoneNumber: "cd" }]]);
    expect(DATA_MANAGER_AUDIENCE_URL).toBe("https://datamanager.googleapis.com/v1/audienceMembers:ingest");
    expect(body.destinations[0].operatingAccount.accountId).toBe("2586857341");
    expect(body.destinations[0].productDestinationId).toBe("123");
    expect(body.audienceMembers[0].userData.userIdentifiers).toEqual([{ emailAddress: "ab" }, { phoneNumber: "cd" }]);
    expect(body.audienceMembers[0].consent.adUserData).toBe("CONSENT_GRANTED");
    expect(body.termsOfService.customerMatchTermsOfServiceStatus).toBe("ACCEPTED");
    expect(body.encoding).toBe("HEX");
  });
  it("does nothing until list IDs are set", () => {
    delete process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID;
    delete process.env.GOOGLE_ADS_CM_QUALIFIED_LIST_ID;
    expect(audienceLists()).toEqual([]);
    process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID = "999";
    expect(audienceLists()).toEqual([{ kind: "funded", listId: "999" }]);
  });
  it("only uploads people who consented, and runs from the conversion worker", () => {
    expect(readFileSync("src/services/googleAudienceSync.ts", "utf8")).toContain("userIdentifiersFor(r.email, r.phone, r.consent)");
    expect(readFileSync("src/workers/adConversionWorker.ts", "utf8")).toContain("syncAudiencesViaDataManager()");
  });
});

describe("visitors page count", () => {
  it("counts the website's pageview events", () => {
    expect(readFileSync("src/routes/marketing/adsStory.ts", "utf8")).toContain("e.event_type IN ('page_view', 'pageview')");
  });
});
