// BF_SERVER_REJECTION_REASONS_v124
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendViaGraph: vi.fn(async (): Promise<unknown> => ({ ok: true, messageId: "m1" })),
  client: { email: "jane@example.com" as string | null, firstName: "Jane" as string | null },
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock };
});
vi.mock("../email/graphSendService.js", () => ({ sendViaGraph: h.sendViaGraph }));
vi.mock("../clientEmail.js", () => ({ resolveClientEmail: vi.fn(async () => ({ ...h.client })), crmContactEmail: vi.fn(async () => null) }));

const mig = readFileSync(resolve(__dirname, "..", "..", "..", "migrations", "2026_08_27_v124_rejection_reasons.sql"), "utf-8");

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const router = (await import("../../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

const REASONS = [
  { code: "tib", label: "Time in business", why_it_matters: "Lenders want <two> years.", what_helps: "Apply again after your second year." },
  { code: "credit", label: "Credit score", why_it_matters: "Below lender minimums.", what_helps: null },
];
function noticeAnswers(opts: { guard?: boolean } = {}) {
  return answerBySql([
    [/SET rejection_email_sent_at = NOW\(\)/, { rows: opts.guard === false ? [] : [{ already: APP_ID }] }],
    [/AS business_name FROM applications/, { rows: [{ business_name: "Acme & Sons" }] }],
    [/FROM application_rejection_reasons arr/, { rows: REASONS }],
  ]);
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
  h.sendViaGraph.mockReset();
  h.sendViaGraph.mockResolvedValue({ ok: true, messageId: "m1" });
  h.client = { email: "jane@example.com", firstName: "Jane" };
});

describe("rejection reason catalogue", () => {
  it("is editable, idempotent, nullable, and exposed to staff", async () => {
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS rejection_reasons");
    expect(mig).toMatch(/what_helps TEXT,/);
    expect(mig).toContain("ON CONFLICT (code) DO NOTHING");
    h.queryMock.mockImplementation(answerBySql([[/FROM rejection_reasons/, { rows: REASONS }]]));
    const res = await request(await buildApp()).get("/api/applications/rejection-reasons").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reasons).toEqual(REASONS);
  });
});

describe("lender pass and auto-close", () => {
  const pass = async (passedAll: boolean) => {
    h.queryMock.mockImplementation(answerBySql([
      [/row_number\(\) OVER/, { rows: [{ lender_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ordinal: "1" }, { lender_id: LENDER_ID, ordinal: "2" }] }],
      [/SELECT label FROM rejection_reasons/, { rows: [{ label: "Time in business" }] }],
      [/AS sent,/, { rows: [{ sent: "2", passed: passedAll ? "2" : "1" }] }],
      [/SET rejection_email_sent_at = NOW\(\)/, { rows: [] }],
    ]));
    return request(await buildApp()).post(`/api/applications/${APP_ID}/lender-response`).set("Authorization", `Bearer ${token()}`).send({ lenderId: LENDER_ID, reasonCodes: ["tib"] });
  };

  it("keeps the ordinal, so repeat passes are distinguishable, with the agreed phrasing", async () => {
    const res = await pass(false);
    expect(res.status).toBe(200);
    const [, params] = callsMatching(h.queryMock, /INSERT INTO communications_messages/)[0]!;
    expect((params as unknown[])[3]).toBe("Lender 2 will pass, due to time in business");
    expect(res.body.data.closed).toBe(false);
  });

  it("closes the file once every sent lender has passed", async () => {
    const res = await pass(true);
    expect(res.body.data.closed).toBe(true);
    expect(callsMatching(h.queryMock, /UPDATE applications SET pipeline_state = 'Rejected'/)).toHaveLength(1);
  });

  it("counts only sent lenders", async () => {
    const { allSentLendersPassed } = await import("../rejectionNotice.js");
    const run = async (sent: string, passed: string) => {
      h.queryMock.mockImplementation(answerBySql([[/AS sent,/, { rows: [{ sent, passed }] }]]));
      return allSentLendersPassed(APP_ID);
    };
    expect(await run("2", "2")).toBe(true);
    expect(await run("2", "1")).toBe(false);
    expect(await run("0", "0")).toBe(false);
    const [sql] = callsMatching(h.queryMock, /AS sent,/)[0]!;
    expect(sqlText(sql)).toContain("sent_at IS NOT NULL");
  });
});

describe("decline email", () => {
  it("deduplicates reasons and sends text and HTML", async () => {
    h.queryMock.mockImplementation(noticeAnswers());
    const { sendRejectionNoticeToClient } = await import("../rejectionNotice.js");
    expect(await sendRejectionNoticeToClient(APP_ID)).toEqual({ sent: true });
    const [sql] = callsMatching(h.queryMock, /FROM application_rejection_reasons arr/)[0]!;
    expect(sqlText(sql)).toContain("SELECT DISTINCT rr.code");
    const mail = (h.sendViaGraph.mock.calls[0] as unknown as [any])[0];
    expect(mail.to).toBe("jane@example.com");
    expect(mail.bodyText).toContain("2 things stood in the way");
    expect(mail.bodyText).toContain("1. Time in business");
    expect(mail.bodyHtml).toContain("<strong>2. Credit score</strong>");
  });

  it("has a send guard: a second notice is not sent", async () => {
    h.queryMock.mockImplementation(noticeAnswers({ guard: false }));
    const { sendRejectionNoticeToClient } = await import("../rejectionNotice.js");
    expect(await sendRejectionNoticeToClient(APP_ID)).toEqual({ sent: false, error: "already_sent" });
    const [sql] = callsMatching(h.queryMock, /SET rejection_email_sent_at = NOW\(\)/)[0]!;
    expect(sqlText(sql)).toContain("rejection_email_sent_at IS NULL");
    expect(h.sendViaGraph).not.toHaveBeenCalled();
  });

  it("releases the guard when the mail does not go out", async () => {
    h.queryMock.mockImplementation(noticeAnswers());
    h.sendViaGraph.mockRejectedValue(new Error("graph down"));
    const { sendRejectionNoticeToClient } = await import("../rejectionNotice.js");
    const out = await sendRejectionNoticeToClient(APP_ID);
    expect(out.sent).toBe(false);
    expect(callsMatching(h.queryMock, /SET rejection_email_sent_at = NULL/)).toHaveLength(1);
  });

  it("escapes applicant content and omits unavailable remediation", async () => {
    h.client = { email: "jane@example.com", firstName: "<b>Jane</b>" };
    h.queryMock.mockImplementation(noticeAnswers());
    const { sendRejectionNoticeToClient } = await import("../rejectionNotice.js");
    await sendRejectionNoticeToClient(APP_ID, "<script>alert(1)</script>");
    const mail = (h.sendViaGraph.mock.calls[0] as unknown as [any])[0];
    expect(mail.bodyHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.bodyHtml).toContain("Hi &lt;b&gt;Jane&lt;/b&gt;,");
    expect(mail.bodyHtml).not.toContain("<script>");
    expect(mail.bodyHtml).toContain("Acme &amp; Sons");
    expect(mail.bodyHtml.match(/What helps:/g)?.length).toBe(1);
    expect(mail.bodyText.match(/What helps:/g)?.length).toBe(1);
  });
});

describe("route ordering", () => {
  // v124 shipped this route below /:id, where Express could never reach it.
  it("declares /rejection-reasons before /:id, or it is unreachable", async () => {
    const router: any = (await import("../../modules/applications/applications.routes.js")).default;
    const getPaths = router.stack.filter((l: any) => l.route?.methods?.get).map((l: any) => l.route.path);
    const cat = getPaths.indexOf("/rejection-reasons");
    const wild = getPaths.indexOf("/:id");
    expect(cat).toBeGreaterThan(-1);
    expect(wild).toBeGreaterThan(-1);
    expect(cat).toBeLessThan(wild);
    // And it really answers: the catalogue, not an application lookup for id "rejection-reasons".
    const res = await request(await buildApp()).get("/api/applications/rejection-reasons").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(callsMatching(h.queryMock, /FROM applications a WHERE a\.id::text/)).toHaveLength(0);
  });

  it("registers the catalogue exactly once", async () => {
    const router: any = (await import("../../modules/applications/applications.routes.js")).default;
    expect(router.stack.filter((l: any) => l.route?.path === "/rejection-reasons" && l.route?.methods?.get)).toHaveLength(1);
  });
});

describe("application-level reject", () => {
  it("requires reasons", async () => {
    const res = await request(await buildApp()).post(`/api/applications/${APP_ID}/reject`).set("Authorization", `Bearer ${token()}`).send({ reasonCodes: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("At least one reason is required.");
  });

  it("stores reasons without a lender", async () => {
    h.queryMock.mockImplementation(answerBySql([[/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }]]));
    const res = await request(await buildApp()).post(`/api/applications/${APP_ID}/reject`).set("Authorization", `Bearer ${token()}`).send({ reasonCodes: ["tib", "credit"] });
    expect(res.status).toBe(200);
    const inserts = callsMatching(h.queryMock, /INSERT INTO application_rejection_reasons/);
    expect(inserts.map((c) => (c[1] as unknown[])[1])).toEqual(["tib", "credit"]);
    for (const [sql] of inserts) expect(sqlText(sql)).toContain("VALUES ($1, NULL, $2, $3)");
  });
});
