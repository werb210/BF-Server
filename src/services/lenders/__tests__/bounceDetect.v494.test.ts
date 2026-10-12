// BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { bootIndex } from "../../../__tests__/helpers/bootIndex.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: queryMock }, runQuery: queryMock }));
import routes from "../../../modules/applications/applications.routes.js";
import { isBounce, bounceReason, failedRecipients } from "../bounceDetect.js";

describe("v494 bounce detection", () => {
  it("recognises Exchange and generic bounce notices, not normal replies", () => {
    expect(isBounce("Undeliverable: Boreal Financial application package: Voss Events", "postmaster@outlook.com")).toBe(true);
    expect(isBounce("Delivery Status Notification (Failure)", "mailer-daemon@googlemail.com")).toBe(true);
    expect(isBounce("RE: Boreal Financial application package: Voss Events", "credit@lender.com")).toBe(false);
  });
  it("classifies the reason", () => {
    expect(bounceReason("Remote server returned '550 5.1.1 RESOLVER.ADR.RecipNotFound; not found'")).toBe("bad_address");
    expect(bounceReason("The recipient's mailbox is full and can't accept messages now.")).toBe("mailbox_full");
    expect(bounceReason("552 5.3.4 Message size exceeds fixed maximum message size")).toBe("too_large");
    expect(bounceReason("550 5.7.1 Message rejected due to content restrictions / policy")).toBe("blocked");
  });
  it("finds the failed recipient and ignores our own mailbox and postmasters", () => {
    const text = "Your message to deals@examplelender.com couldn't be delivered. From: submissions@boreal.financial postmaster@outlook.com";
    expect(failedRecipients(text, ["submissions@boreal.financial"])).toEqual(["deals@examplelender.com"]);
  });
  it("worker is started inside the gated worker block", async () => {
    const on = await bootIndex({ env: { BF_WORKERS_ENABLED: "true" } });
    try {
      await on.workersDone();
      expect(on.workerCalls.get("startLenderBounceWorker")).toEqual([[on.pool]]);
    } finally { on.restore(); }
    const off = await bootIndex({ env: { BF_WORKERS_ENABLED: "false" } });
    try {
      expect(off.workerCalls.has("startLenderBounceWorker")).toBe(false);
    } finally { off.restore(); }
  });

  it("sent-lenders returns the bounce", async () => {
    const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([
      [/SELECT silo FROM applications WHERE id::text/, { rows: [{ silo: "BF" }] }],
      [/FROM application_packages p/, { rows: [
        { lender_id: "L1", sent_at: "2026-09-01T00:00:00Z", sent_manually: false, link_count: 0, download_count: 0, last_downloaded_at: null, bounce_reason: "bad_address", bounce_recipient: "deals@examplelender.com", bounced_at: "2026-09-01T00:05:00Z" },
        { lender_id: "L2", sent_at: "2026-09-01T00:00:00Z", sent_manually: false, link_count: 1, download_count: 2, last_downloaded_at: null, bounce_reason: null, bounce_recipient: null, bounced_at: null },
      ] }],
    ]));
    const app = express();
    app.use("/api/applications", routes);
    const token = jwt.sign({ sub: "00000000-0000-0000-0000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0, capabilities: ["application:read"] }, process.env.JWT_SECRET as string);
    const r = await request(app).get(`/api/applications/${APP_ID}/sent-lenders`).set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.sent[0].bounce).toEqual({ reason: "bad_address", recipient: "deals@examplelender.com", at: "2026-09-01T00:05:00Z" });
    expect(r.body.data.sent[1].bounce).toBeNull();
    const sql = String(callsMatching(queryMock, /FROM application_packages p/)[0][0]);
    expect(sql).toMatch(/LEFT JOIN LATERAL \(\s+SELECT reason, recipient, received_at FROM lender_email_bounces x/);
    expect(sql).toContain("AND x.received_at >= p.sent_at"); // only bounces of this send
  });
});
