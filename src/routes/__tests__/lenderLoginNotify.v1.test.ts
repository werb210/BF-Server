import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const authSource = fs.readFileSync(path.resolve("src/routes/auth.ts"), "utf8");

describe("lender portal login staff notification", () => {
  it("is emitted only from the successful lender OTP branch", () => {
    const lenderBranch = authSource.slice(
      authSource.indexOf("if (wantsLender)"),
      authSource.indexOf("const wantsReferrer"),
    );

    expect(lenderBranch).toContain("BF_SERVER_LENDER_LOGIN_NOTIFY_v1");
    expect(lenderBranch).toContain('notificationType: "lender_portal_login"');
    expect(lenderBranch).toContain("void (async () => {");
    expect(lenderBranch.indexOf("notifyAllStaff")).toBeGreaterThan(lenderBranch.indexOf("signAccessToken"));
  });

  it("creates a bell-only notification linked to the lender", () => {
    expect(authSource).toContain("skipSms: true");
    expect(authSource).toContain('refTable: "lenders"');
    expect(authSource).toContain("contextUrl: `/lenders/${lender.id}`");
    expect(authSource).toContain("lender login notification failed");
  });
});
