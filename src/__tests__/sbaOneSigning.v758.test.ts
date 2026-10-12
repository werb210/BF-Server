// BF_SERVER_SBA_ONE_SIGNING_v758
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "./helpers/answerBySql.js";
import { postSignnowWebhook, signnowWebhookApp } from "./helpers/signnowWebhook.js";

const envelopesRow: { value: any[] } = { value: [] };
const groupSigned = new Map<string, boolean>();
const { dbQuery, poolQuery, sendSbaMock, maybeStartMock, isSbaMock, finalizeMock } = vi.hoisted(() => ({
  dbQuery: vi.fn(), poolQuery: vi.fn(), sendSbaMock: vi.fn(), maybeStartMock: vi.fn(), isSbaMock: vi.fn(), finalizeMock: vi.fn(),
}));
const BASE_RULES: SqlRule[] = [
  [/^\s*SELECT metadata FROM applications/, () => ({ rows: [{ metadata: { sba_signnow: envelopesRow.value } }] })],
];
vi.mock("../db.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), dbQuery, runQuery: dbQuery, pool: { query: poolQuery } }));
vi.mock("../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<any>()),
  isApiKeyConfigured: () => true,
  getDocumentGroupStatus: vi.fn(async (id: string) => ({ signed: groupSigned.get(id) === true })),
  createEmbeddedGroupLink: vi.fn(async (_g: string, _i: string, email: string) => ({ url: "https://signnow.test/link?for=" + email })),
}));
vi.mock("../signnow/sba/sbaTrigger.js", async (orig) => ({
  ...(await orig<any>()),
  sendSbaForSigning: sendSbaMock,
  maybeStartSbaSigning: maybeStartMock,
  isSbaApplication: isSbaMock,
}));
vi.mock("../signnow/sba/sbaSigning.js", async (orig) => ({ ...(await orig<any>()), attachSignedSbaDocuments: vi.fn(async () => ({ attached: 0 })) }));
vi.mock("../signnow/finalizeSignedApplication.js", () => ({ finalizeSignedApplication: finalizeMock }));
vi.mock("../services/feeAgreement/mediaFeeAgreement.js", () => ({ confirmFeeAgreementBySignNowIds: vi.fn(async () => ({ matched: false })) }));

import { buildApplicationPdf } from "../signnow/pdfBuilder.js";
import { sbaOwnerOneSigningSession, sbaCombinedApplicationDocIfAllSigned } from "../signnow/sba/sbaSigning.js";

const inputs: any = {
  applicationId: "a1", product: { lookingFor: "Working Capital", category: "SBA", amountRequested: 500000 }, funding: {},
  business: { legalName: "Voss Events" },
  owners: [{ label: "Owner 1", firstName: "Brandon", lastName: "Voss", email: "b@x.com" }, { label: "Owner 2", firstName: "Pat", lastName: "Partner", email: "p@x.com" }],
  applicantEmail: "b@x.com", applicantName: "Brandon Voss",
};
const TWO_OWNERS = () => [
  { ownerIndex: 1, email: "b@x.com", groupId: "g1", inviteId: "i1", docIds: ["app1"], applicationDocId: "app1" },
  { ownerIndex: 2, email: "p@x.com", groupId: "g2", inviteId: "i2", docIds: ["app2"], applicationDocId: "app2" },
];

beforeEach(() => {
  envelopesRow.value = [];
  groupSigned.clear();
  dbQuery.mockReset();
  dbQuery.mockImplementation(answerBySql(BASE_RULES));
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  sendSbaMock.mockReset();
  maybeStartMock.mockReset();
  isSbaMock.mockReset();
  finalizeMock.mockReset();
  finalizeMock.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("one signing per owner", () => {
  it("each owner's copy of the application carries only that owner's signature tag", async () => {
    const all = { dateAnchors: [] as any[] };
    await buildApplicationPdf(inputs, all);
    expect(all.dateAnchors.map((a) => a.role)).toEqual(["Owner 1", "Owner 2"]);
    const mine = { dateAnchors: [] as any[] };
    const bytes = await buildApplicationPdf(inputs, mine, { signOnlyAs: "Owner 2" });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(mine.dateAnchors.map((a) => a.role)).toEqual(["Owner 2"]);
  });
  it("owner 1 gets a fresh portal link, 'signed' once done, and 'not started' before staff send", async () => {
    expect(await sbaOwnerOneSigningSession("a1")).toEqual({ status: "not_ready", reason: "sba_signing_not_started" });
    envelopesRow.value = [{ ownerIndex: 1, email: "b@x.com", groupId: "g1", inviteId: "i1", docIds: ["app1", "f1"], applicationDocId: "app1", delivery: "portal" }];
    const r: any = await sbaOwnerOneSigningSession("a1");
    expect(r.status).toBe("ready");
    expect(r.url).toContain("for=b@x.com");
    groupSigned.set("g1", true);
    expect(await sbaOwnerOneSigningSession("a1")).toEqual({ status: "signed" });
  });
  it("the application counts as signed only when every owner's envelope is signed", async () => {
    envelopesRow.value = TWO_OWNERS();
    groupSigned.set("g1", true);
    expect(await sbaCombinedApplicationDocIfAllSigned("a1")).toBeNull();
    groupSigned.set("g2", true);
    expect(await sbaCombinedApplicationDocIfAllSigned("a1")).toBe("app1");
  });
});

describe("is wired: staff route, client portal sign item, no auto-start, finalize on the webhook", () => {
  const STAFF = "00000000-0000-4000-8000-0000000000a1";
  const tok = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
  async function formsApp() {
    const router = (await import("../routes/applicationFormResponses.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    return app;
  }

  it("staff send the SBA signing from POST /applications/:id/sba-signing/send", async () => {
    sendSbaMock.mockResolvedValue({ ok: true, owners: 2 });
    const app = await formsApp();
    expect((await request(app).post("/api/applications/a1/sba-signing/send")).status).toBe(401);
    const res = await request(app).post("/api/applications/a1/sba-signing/send").set("Authorization", `Bearer ${tok()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", data: { ok: true, owners: 2 } });
    expect(sendSbaMock).toHaveBeenCalledWith("a1");
  });

  it("submitting the last SBA form does not start signing on its own", async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: "f1", doc_type: "sba_form_1919", data: {} }], rowCount: 1 });
    const res = await request(await formsApp()).post("/api/applications/a1/form-responses/sba_form_1919/submit")
      .set("Authorization", `Bearer ${tok()}`).send({ data: { done: true } });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(maybeStartMock).not.toHaveBeenCalled();
    expect(sendSbaMock).not.toHaveBeenCalled();
  });

  it("the client portal's sign item opens owner 1's SBA signing", async () => {
    isSbaMock.mockResolvedValue(true);
    dbQuery.mockImplementation(answerBySql([
      [/SELECT a\.signnow_app_signed_at, a\.metadata/, { rows: [{ signnow_app_signed_at: null, metadata: {}, finalized_count: "0" }] }],
      ...BASE_RULES,
    ]));
    envelopesRow.value = TWO_OWNERS();
    const { getOrCreateEmbeddedSigningSession } = await import("../signnow/embeddedSigningSession.js");
    const r: any = await getOrCreateEmbeddedSigningSession("a1");
    expect(r).toMatchObject({ status: "ready" });
    expect(r.url).toContain("for=b@x.com");
    groupSigned.set("g1", true);
    expect(await getOrCreateEmbeddedSigningSession("a1")).toEqual({ status: "signed" });
  });

  it("the webhook finalizes the application once every owner's envelope is signed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dbQuery.mockImplementation(answerBySql([
      [/jsonb_array_elements\(COALESCE\(a\.metadata->'sba_signnow'/, { rows: [{ id: "a1" }] }],
      [/select contact_id from applications/, { rows: [{ contact_id: "c1" }] }],
      ...BASE_RULES,
    ]));
    envelopesRow.value = TWO_OWNERS();
    const router = (await import("../routes/signnow.js")).default;
    const app = signnowWebhookApp(router);

    groupSigned.set("g1", true);
    const early = await postSignnowWebhook(app, { event: "document.complete", document_group_id: "g1", email: "b@x.com" });
    expect(early.body).toMatchObject({ received: true, match: "sba" });
    expect(finalizeMock).not.toHaveBeenCalled();

    groupSigned.set("g2", true);
    const last = await postSignnowWebhook(app, { event: "document.complete", document_group_id: "g2", email: "p@x.com" });
    expect(last.body).toMatchObject({ received: true, match: "sba" });
    expect(finalizeMock).toHaveBeenCalledWith({ id: "a1", contactId: "c1" }, { signerEmail: "p@x.com", documentId: "app1" });
    expect(callsMatching(dbQuery, /jsonb_array_elements/)[0]![1]).toEqual([["g1"]]);
  });
});
