// BF_SERVER_ATTRIBUTION_TO_CONTACT_v1 - gclid/UTM attribution stored on the
// application is stamped onto the CRM contact timeline at mirror time.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";

const { queryMock, mirrorMock, adsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mirrorMock: vi.fn(),
  adsMock: vi.fn(async () => undefined),
}));

vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../services/googleAdsAttribution.js", () => ({ resolveAndStoreAdAttribution: adsMock }));

describe("attribution to contact", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    adsMock.mockClear();
    mirrorMock.mockReset();
  });

  it("mirror writes an attribution timeline event on the contact", async () => {
    queryMock.mockImplementation(
      answerBySql([
        [/INSERT INTO contacts/, { rows: [{ id: "contact-9" }] }],
        [/information_schema\.columns/, { rows: [{ exists: true }] }],
      ]),
    );
    const { mirrorApplicationToCrm } = await vi.importActual<typeof import("../services/applicationCrmMirror.js")>(
      "../services/applicationCrmMirror.js",
    );
    await mirrorApplicationToCrm({
      applicationId: APP_ID,
      silo: "BF",
      applicant: { firstName: "Ann", lastName: "Lee", email: "ann@acme.test" },
      attribution: { gclid: "gclid-123", utm_source: "google" },
    });
    const events = callsMatching(queryMock, /INSERT INTO crm_timeline_events/);
    expect(events).toHaveLength(1);
    expect(String(events[0]![0])).toContain("'attribution'");
    const [contactId, payload] = events[0]![1] as [string, string];
    expect(contactId).toBe("contact-9");
    expect(JSON.parse(payload)).toEqual({ applicationId: APP_ID, gclid: "gclid-123", utm_source: "google" });
    expect(adsMock).toHaveBeenCalledWith(expect.objectContaining({ contactId: "contact-9", gclid: "gclid-123", applicationId: APP_ID }));
  });

  it("mirror writes no attribution event when the application carries none", async () => {
    queryMock.mockImplementation(
      answerBySql([
        [/INSERT INTO contacts/, { rows: [{ id: "contact-9" }] }],
        [/information_schema\.columns/, { rows: [{ exists: true }] }],
      ]),
    );
    const { mirrorApplicationToCrm } = await vi.importActual<typeof import("../services/applicationCrmMirror.js")>(
      "../services/applicationCrmMirror.js",
    );
    await mirrorApplicationToCrm({ applicationId: APP_ID, silo: "BF", applicant: { email: "ann@acme.test" }, attribution: null });
    expect(callsMatching(queryMock, /crm_timeline_events/)).toHaveLength(0);
  });

  describe("submit", () => {
    beforeEach(() => {
      vi.doMock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: mirrorMock }));
      queryMock.mockImplementation(answerBySql(submitBaseRules()));
    });

    it("forwards attribution from application metadata", async () => {
      const attribution = { gclid: "gclid-abc", utm_campaign: "spring" };
      const res = await request(await buildV1App())
        .post(`/api/client/applications/${APP_ID}/submit`)
        .send({ app: { business: { companyName: "Acme" }, metadata: { attribution } } });
      expect(res.status).toBe(200);
      expect(mirrorMock).toHaveBeenCalledTimes(1);
      expect(mirrorMock.mock.calls[0]![0]).toMatchObject({ applicationId: APP_ID, attribution });
    });

    it("also accepts attribution at the top level of the app payload", async () => {
      const attribution = { gclid: "gclid-top" };
      await request(await buildV1App())
        .post(`/api/client/applications/${APP_ID}/submit`)
        .send({ app: { business: { companyName: "Acme" }, attribution } });
      expect(mirrorMock.mock.calls[0]![0]).toMatchObject({ attribution });
    });
  });
});
