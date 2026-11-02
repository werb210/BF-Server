// BF_SERVER_v865_BROKER_TOOLS_1_FUNDING_CONDITIONS - the checklist rules and the Funded gate (database faked by SQL content).
import { describe, expect, it } from "vitest";
import { checkFundingGate, clientView, conditionsFromOfferText, FundingBlockedError, outstanding, parseConditionInput, rowToCondition } from "../conditions.js";
import { canTransition, ApplicationStage, statusFromPipeline } from "../../modules/applications/pipelineState.js";

const row = (o: Record<string, unknown>) => rowToCondition({ id: "c1", application_id: "a1", title: "T", owner: "staff", status: "open", ...o }, new Date("2026-11-10T12:00:00Z"));

function fakeDb(rows: Record<string, unknown>[]) {
  return {
    query: async (sql: string) => {
      if (/FROM funding_conditions fc/.test(sql)) return { rows };
      throw new Error("unexpected SQL: " + sql.slice(0, 60));
    },
  };
}

describe("funding conditions", () => {
  it("reads the lender's offer notes as one condition per line", () => {
    const text = "Conditions:\n- Void cheque\n1. Insurance certificate naming the lender\n* void cheque\n\nSubject to:\n(a) Signed PAD form; Final invoice";
    expect(conditionsFromOfferText(text)).toEqual(["Void cheque", "Insurance certificate naming the lender", "Signed PAD form", "Final invoice"]);
    expect(conditionsFromOfferText(null)).toEqual([]);
  });

  it("marks overdue only for open items past their date", () => {
    expect(row({ due_date: "2026-11-01" }).overdue).toBe(true);
    expect(row({ due_date: "2026-11-01", status: "cleared" }).overdue).toBe(false);
    expect(row({ due_date: "2026-12-01" }).overdue).toBe(false);
  });

  it("counts open and received as outstanding, cleared and waived as done", () => {
    const list = ["open", "received", "cleared", "waived"].map((status, i) => row({ id: `c${i}`, status }));
    expect(outstanding(list).map((c) => c.status)).toEqual(["open", "received"]);
  });

  it("validates input", () => {
    expect(parseConditionInput({ title: "" }).ok).toBe(false);
    expect(parseConditionInput({ title: "Ok", due_date: "30/11/2026" }).ok).toBe(false);
    expect(parseConditionInput({ title: "Ok", document_url: "ftp://x" }).ok).toBe(false);
    const p = parseConditionInput({ title: " Insurance ", owner: "CLIENT", due_date: "2026-11-30" });
    expect(p.ok && p.value).toMatchObject({ title: "Insurance", owner: "client", due_date: "2026-11-30" });
  });

  it("blocks Funded while anything is open; only an Admin with a reason may override", async () => {
    const open = fakeDb([{ id: "c1", application_id: "a1", title: "Void cheque", owner: "client", status: "open" }]);
    await expect(checkFundingGate(open, "a1", { isAdmin: false, overrideReason: "lender confirmed" })).rejects.toBeInstanceOf(FundingBlockedError);
    await expect(checkFundingGate(open, "a1", { isAdmin: true, overrideReason: "" })).rejects.toBeInstanceOf(FundingBlockedError);
    await expect(checkFundingGate(open, "a1", { isAdmin: true, overrideReason: "Lender funded on verbal" })).resolves.toEqual({ outstanding: 1, overridden: true });
    const done = fakeDb([{ id: "c1", application_id: "a1", title: "Void cheque", owner: "client", status: "waived" }]);
    await expect(checkFundingGate(done, "a1", { isAdmin: false })).resolves.toEqual({ outstanding: 0, overridden: false });
  });

  it("shows the client only their own open items, without staff notes", () => {
    const list = [row({ id: "1", owner: "client", note: "internal", client_submitted_at: "2026-11-02T00:00:00Z", status: "received" }), row({ id: "2", owner: "staff" }), row({ id: "3", owner: "client", status: "cleared" })];
    const v = clientView(list);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: "1", submitted: true });
    expect(JSON.stringify(v)).not.toContain("internal");
  });

  it("puts Funded after Accepted", () => {
    expect(canTransition(ApplicationStage.ACCEPTED, ApplicationStage.FUNDED)).toBe(true);
    expect(canTransition(ApplicationStage.OFFER, ApplicationStage.FUNDED)).toBe(false);
    expect(canTransition(ApplicationStage.FUNDED, ApplicationStage.HOLD)).toBe(true);
    expect(statusFromPipeline(ApplicationStage.FUNDED)).toBe("ACCEPTED");
  });
});
