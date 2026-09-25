// BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  it("worker is started inside the gated worker block and sent-lenders returns the bounce", () => {
    const index = readFileSync(fileURLToPath(new URL("../../../index.ts", import.meta.url)), "utf-8");
    const routes = readFileSync(fileURLToPath(new URL("../../../modules/applications/applications.routes.ts", import.meta.url)), "utf-8");
    const gate = index.indexOf("bfWorkersEnabled()) {");
    const start = index.indexOf("startLenderBounceWorker(pool)");
    expect(gate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(gate);
    expect(routes).toContain("LEFT JOIN LATERAL (");
    expect(routes).toContain("bounce: x.bounce_reason ?");
  });
});
