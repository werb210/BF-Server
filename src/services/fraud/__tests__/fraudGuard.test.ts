// BF_SERVER_FRAUD_ENFORCE_v50
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  isApplicationFraud, contactHasFraudApplication,
  assertApplicationNotFraud, FraudLockedError, FRAUD_LOCK_MESSAGE,
} from "../fraudGuard.js";

const poolWith = (rowCount: number) => ({ query: vi.fn().mockResolvedValue({ rowCount, rows: [] }) });
const failingPool = () => ({ query: vi.fn().mockRejectedValue(new Error("db down")) });

describe("isApplicationFraud", () => {
  it("is true when the application is parked in Fraud", async () => {
    await expect(isApplicationFraud(poolWith(1) as any, "app-1")).resolves.toBe(true);
  });
  it("is false for a working application", async () => {
    await expect(isApplicationFraud(poolWith(0) as any, "app-1")).resolves.toBe(false);
  });
  it("does not query at all without an application id", async () => {
    const pool = poolWith(1);
    await expect(isApplicationFraud(pool as any, "")).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("filters on the Fraud stage, not on Hold", async () => {
    const pool = poolWith(0);
    await isApplicationFraud(pool as any, "app-1");
    expect(pool.query.mock.calls[0]?.[1]).toEqual(["app-1", "Fraud"]);
  });
  it("does not throw when the lookup fails", async () => {
    await expect(isApplicationFraud(failingPool() as any, "app-1")).resolves.toBe(false);
  });
});

describe("contactHasFraudApplication", () => {
  it("catches a contact linked through application_contacts, not just contact_id", async () => {
    const pool = poolWith(1);
    await expect(contactHasFraudApplication(pool as any, "c-1")).resolves.toBe(true);
    expect(pool.query.mock.calls[0]?.[0]).toContain("application_contacts");
  });
  it("is false for a contact with no fraud file", async () => {
    await expect(contactHasFraudApplication(poolWith(0) as any, "c-1")).resolves.toBe(false);
  });
});

describe("assertApplicationNotFraud", () => {
  it("throws a 423 for a fraud application", async () => {
    await expect(assertApplicationNotFraud(poolWith(1) as any, "app-1")).rejects.toBeInstanceOf(FraudLockedError);
    try { await assertApplicationNotFraud(poolWith(1) as any, "app-1"); }
    catch (e) {
      expect((e as FraudLockedError).status).toBe(423);
      expect((e as FraudLockedError).message).toBe(FRAUD_LOCK_MESSAGE);
    }
  });
  it("says plainly that nothing was deleted", () => {
    expect(FRAUD_LOCK_MESSAGE).toContain("retained");
  });
  it("passes a working application through", async () => {
    await expect(assertApplicationNotFraud(poolWith(0) as any, "app-1")).resolves.toBeUndefined();
  });
});

describe("enforcement is wired at the choke points", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("refuses a fraud file before a lender package is built", () => {
    const src = read("src/services/lenders/dispatchToSelected.ts");
    expect(src).toContain("await assertApplicationNotFraud(ctx.pool, ctx.applicationId);");
    expect(src.indexOf("assertApplicationNotFraud")).toBeLessThan(src.indexOf("loadPackageInputs(ctx)"));
  });
  it("locks the applicant out of a fraud file", () => {
    const src = read("src/routes/client/index.ts");
    expect(src).toContain('res.status(423).json({ error: "application_locked"');
  });
  it("cancels rather than pauses a marketing enrollment on a fraud contact", () => {
    const src = read("src/services/sequenceEngine.ts");
    expect(src).toContain("contactHasFraudApplication(pool, en.contact_id)");
    expect(src).toContain("status='cancelled'");
  });
});
