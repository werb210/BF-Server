// BF_SERVER_BLOCK_v547_CLIENT_REACTIVATE
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { reactivateHeldApplication } from "../clientReactivation.js";

const fakes = (onHold: boolean) => ({
  claim: vi.fn(async () => onHold),
  moveToInReview: vi.fn(async () => undefined),
  tellStaff: vi.fn(async () => undefined),
});

describe("v547 client reactivates an on-hold file", () => {
  it("moves a held file to In Review and tells staff", async () => {
    const d = fakes(true);
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: true });
    expect(d.moveToInReview).toHaveBeenCalledWith("a1");
    expect(d.tellStaff).toHaveBeenCalledWith("a1");
  });
  it("does nothing to a file that is not on hold (including Fraud)", async () => {
    const d = fakes(false);
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: false, error: "not_on_hold" });
    expect(d.moveToInReview).not.toHaveBeenCalled();
    expect(d.tellStaff).not.toHaveBeenCalled();
  });
  it("a failed staff notice does not undo the reactivation", async () => {
    const d = { ...fakes(true), tellStaff: vi.fn(async () => { throw new Error("sms down"); }) };
    expect(await reactivateHeldApplication("a1", d)).toEqual({ ok: true });
  });
  it("claims only a file still on Hold, atomically", () => {
    const src = readFileSync("src/services/clientReactivation.ts", "utf-8");
    expect(src).toMatch(/WHERE id::text = \(\$1\)::text AND pipeline_state = \$2\s+RETURNING id/);
    expect(src).toContain("[applicationId, ApplicationStage.HOLD]");
  });
  it("the route requires sign-in and ownership", () => {
    const route = readFileSync("src/routes/client/v1Applications.ts", "utf-8");
    const at = route.indexOf('\"/applications/:id/reactivate\"');
    expect(at).toBeGreaterThan(0);
    const body = route.slice(at, at + 900);
    expect(body).toContain("requireAuth");
    expect(body).toContain("callerOwnsApplication(req, applicationId)");
    expect(body).toContain("409");
  });
});
