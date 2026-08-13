// BF_SERVER_FRAUD_ENFORCE_v50
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  isApplicationFraud, contactHasFraudApplication,
  assertApplicationNotFraud, FraudLockedError, FRAUD_LOCK_MESSAGE,
} from "../fraudGuard.js";

// BF_SERVER_FRAUD_GUARD_ROWS_v53 - the stub returns rows, because the guard now
// reads the value back instead of trusting rowCount.
const fraudPool = () => ({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ pipeline_state: "Fraud", fraud_application_id: "app-1" }] }) });
const workingPool = () => ({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ pipeline_state: "Off to Lender" }] }) });
const emptyPool = () => ({ query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) });
// A stub that answers every query with something truthy - the shape used by
// unrelated tests that mock a pool. This must NOT read as fraud.
const genericStubPool = () => ({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "whatever" }] }) });
const failingPool = () => ({ query: vi.fn().mockRejectedValue(new Error("db down")) });

describe("isApplicationFraud", () => {
  it("is true when the application is parked in Fraud", async () => {
    await expect(isApplicationFraud(fraudPool() as any, "app-1")).resolves.toBe(true);
  });
  it("is false for a working application", async () => {
    await expect(isApplicationFraud(emptyPool() as any, "app-1")).resolves.toBe(false);
  });
  it("does not query at all without an application id", async () => {
    const pool = fraudPool();
    await expect(isApplicationFraud(pool as any, "")).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("reads the stage back rather than trusting rowCount", async () => {
    await expect(isApplicationFraud(workingPool() as any, "app-1")).resolves.toBe(false);
  });
  it("does not read a generic stubbed pool as fraud", async () => {
    // Regression: v50 inferred fraud from rowCount, so every test that mocks a
    // pool with a canned result had its application locked and threw.
    await expect(isApplicationFraud(genericStubPool() as any, "app-1")).resolves.toBe(false);
    await expect(assertApplicationNotFraud(genericStubPool() as any, "app-1")).resolves.toBeUndefined();
  });
  it("does not throw when the lookup fails", async () => {
    await expect(isApplicationFraud(failingPool() as any, "app-1")).resolves.toBe(false);
  });
});

describe("contactHasFraudApplication", () => {
  it("catches a contact linked through application_contacts, not just contact_id", async () => {
    const pool = fraudPool();
    await expect(contactHasFraudApplication(pool as any, "c-1")).resolves.toBe(true);
    expect(pool.query.mock.calls[0]?.[0]).toContain("application_contacts");
  });
  it("is false for a contact with no fraud file", async () => {
    await expect(contactHasFraudApplication(emptyPool() as any, "c-1")).resolves.toBe(false);
  });
});

describe("assertApplicationNotFraud", () => {
  it("throws a 423 for a fraud application", async () => {
    await expect(assertApplicationNotFraud(fraudPool() as any, "app-1")).rejects.toBeInstanceOf(FraudLockedError);
    try { await assertApplicationNotFraud(fraudPool() as any, "app-1"); }
    catch (e) {
      expect((e as FraudLockedError).status).toBe(423);
      expect((e as FraudLockedError).message).toBe(FRAUD_LOCK_MESSAGE);
    }
  });
  it("says plainly that nothing was deleted", () => {
    expect(FRAUD_LOCK_MESSAGE).toContain("retained");
  });
  it("passes a working application through", async () => {
    await expect(assertApplicationNotFraud(emptyPool() as any, "app-1")).resolves.toBeUndefined();
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
