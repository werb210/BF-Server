// BF_SERVER_FRAUD_ENFORCE_v50
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const h = vi.hoisted(() => ({ query: vi.fn(), loadPackageInputs: vi.fn(), questionsGate: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../../lenders/loadPackageInputs.js", async (orig) => ({ ...(await orig<any>()), loadPackageInputs: h.loadPackageInputs }));
vi.mock("../../productQuestions/sendGate.js", async (orig) => ({ ...(await orig<any>()), assertProductQuestionsAnswered: h.questionsGate }));

import { dispatchToSelected } from "../../lenders/dispatchToSelected.js";
import { tickSequences } from "../../sequenceEngine.js";
import clientRouter from "../../../routes/client/index.js";
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
  const stagePool = (stage: string) => ({ query: vi.fn(answerBySql([[/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: stage }] }]])) });

  it("refuses a fraud file before a lender package is built", async () => {
    h.loadPackageInputs.mockReset();
    h.questionsGate.mockReset();
    const pool = stagePool("Fraud");
    await expect(dispatchToSelected({ pool: pool as any, applicationId: APP }, [])).rejects.toBeInstanceOf(FraudLockedError);
    expect(h.questionsGate).not.toHaveBeenCalled();
    expect(h.loadPackageInputs).not.toHaveBeenCalled();
    expect(callsMatching(pool.query, /SELECT pipeline_state FROM applications/)[0]![1]).toEqual([APP]);

    // A working file goes on to build its package.
    h.loadPackageInputs.mockRejectedValue(new Error("stop here"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await dispatchToSelected({ pool: stagePool("Off to Lender") as any, applicationId: APP }, []).catch(() => undefined);
    expect(h.loadPackageInputs).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("locks the applicant out of a fraud file", async () => {
    const OWNER = "+15875550123";
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Fraud" }] }],
      [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
      [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
    ]));
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    for (const r of [
      await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token),
      await request(app).post("/api/client/messages").set("Authorization", token).send({ applicationId: APP, body: "hello" }),
    ]) {
      expect(r.status).toBe(423);
      expect(r.body).toEqual({ error: "application_locked", message: FRAUD_LOCK_MESSAGE });
    }
    expect(callsMatching(h.query, /communications_messages/)).toHaveLength(0);
  });

  it("cancels rather than pauses a marketing enrollment on a fraud contact", async () => {
    let claimed = false;
    const query = vi.fn(answerBySql([
      [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [{ id: "en-1", sequence_id: "seq-1", contact_id: "c-fraud", current_step: 0 }] }))],
      [/SELECT a\.id AS fraud_application_id/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "c-fraud" ? [{ fraud_application_id: "app-9" }] : [] })],
    ]));
    await tickSequences({ query } as any);
    expect(callsMatching(query, /SELECT a\.id AS fraud_application_id/)[0]![1]).toEqual(["c-fraud", "Fraud"]);
    expect(callsMatching(query, "status='cancelled'").map((c) => c[1])).toEqual([["en-1"]]);
    expect(callsMatching(query, /SET status='paused'|SET status='active'/)).toHaveLength(0);
    expect(callsMatching(query, /marketing_sequence_steps|FROM marketing_sequences s WHERE/)).toHaveLength(0);
  });
});
