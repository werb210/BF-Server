// BF_SERVER_SUGGESTED_NEXT_ACTIONS_v207
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNextActions } from "../nextActions.js";

const svc = readFileSync("src/services/nextActions.ts", "utf-8");
const route = readFileSync("src/routes/mayaStaff.ts", "utf-8");

describe("what it suggests", () => {
  it("never suggests anything about a closed file", () => {
    expect(svc).toContain("!~* 'funded|declined|closed|rejected'");
  });

  it("ranks a broken promise above a merely quiet file", () => {
    const promised = svc.indexOf("documents were promised");
    const quiet = svc.indexOf("the file has gone quiet");
    expect(svc.slice(promised, promised + 400)).toContain("100 AS priority");
    expect(svc.slice(quiet, quiet + 400)).toContain("50 AS priority");
  });

  it("only flags a promise the client has not since kept", () => {
    expect(svc).toMatch(/NOT EXISTS \([\s\S]{0,300}d\.created_at > cl\.created_at/);
  });

  it("ignores soft-deleted uploads when deciding a promise was kept", () => {
    expect(svc).toContain("d.deleted_at IS NULL");
  });

  it("only says every lender passed when at least one actually responded", () => {
    expect(svc).toContain("COUNT(*) > 0");
    expect(svc).toContain("COUNT(*) FILTER (WHERE r.outcome <> 'declined') = 0");
  });
});

describe("how it presents them", () => {
  it("shows one suggestion per application, the most urgent", () => {
    expect(svc).toContain("if (!prior || item.priority > prior.priority) best.set");
  });

  it("gives every suggestion a reason a person can act on", () => {
    // A suggestion without a why is one staff will learn to scroll past.
    const actions = [...svc.matchAll(/'([^']+)' AS action/g)].map((m) => m[1]);
    const reasons = [...svc.matchAll(/AS reason/g)];
    expect(actions.length).toBeGreaterThan(0);
    expect(reasons.length).toBe(actions.length);
  });

  it("is rule-based, so every suggestion is explainable", () => {
    expect(svc).not.toMatch(/openai|askAI|model|embedding/i);
  });

  it("only suggests - it never writes", () => {
    expect(svc).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
  });
});

describe("it cannot break the caller", () => {
  it("degrades to an empty list rather than throwing", () => {
    expect(svc).toContain(".catch(() => ({ rows: [] as any[] }))");
  });

  it("clamps the limit so a caller cannot ask for everything", () => {
    expect(svc).toContain("Math.max(1, Math.min(limit, 100))");
  });

  it("is a pure function of its query result", async () => {
    // With no database in the test environment the query rejects, the catch
    // fires, and the result must be an empty array rather than an exception.
    await expect(buildNextActions("BF")).resolves.toEqual([]);
  });
});

describe("route", () => {
  it("requires the same service token as the rest of mayaStaff", () => {
    const block = route.slice(route.indexOf('\"/staff/next-actions\"'));
    expect(block.slice(0, 400)).toContain("verifyMayaService(req)");
  });
});
