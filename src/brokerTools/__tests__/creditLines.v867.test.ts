// BF_SERVER_v867_BROKER_TOOLS_CREDIT_LINES - limit, used and available; draws; expiry reminders (database faked by SQL content).
import { describe, expect, it } from "vitest";
import { DrawError, addDraw, creditLineReminders, parseLineInput, summarise } from "../creditLines.js";

const base = { id: "11111111-1111-4111-8111-111111111111", silo: "BF", lender_name: "Northern Capital", limit_amount: "250000.00", expiry_date: "2026-12-15", reminder_days: 30, status: "active" };
const draws = [
  { id: "d1", kind: "draw", amount: "100000", drawn_on: "2026-06-01" },
  { id: "d2", kind: "repayment", amount: "25000", drawn_on: "2026-08-01" },
  { id: "d3", kind: "draw", amount: "40000", drawn_on: "2026-09-01", reversed_at: new Date() },
];

describe("credit lines", () => {
  it("works out used and available from draws and repayments; reversed draws do not count", () => {
    const l = summarise(base, draws, "2026-11-01");
    expect(l).toMatchObject({ used: 75000, available: 175000, days_to_expiry: 44, expiring_soon: false, status: "active", over_limit: false });
    expect(summarise(base, draws, "2026-11-20").expiring_soon).toBe(true);
    expect(summarise(base, draws, "2026-12-16").status).toBe("expired");
  });

  it("validates a new line", () => {
    expect(parseLineInput({ lender_name: "X" }).ok).toBe(false);
    expect(parseLineInput({ limit_amount: "$250,000" }).ok).toBe(false);
    expect(parseLineInput({ lender_name: "X", limit_amount: 1000, expiry_date: "15/12/2026" }).ok).toBe(false);
    const p = parseLineInput({ lender_name: " Northern Capital ", limit_amount: "$250,000", expiry_date: "2026-12-15", reminder_days: "45" });
    expect(p.ok && p.value).toMatchObject({ lender_name: "Northern Capital", limit_amount: 250000, expiry_date: "2026-12-15", reminder_days: 45 });
  });

  it("refuses a draw over what is available, or on an expired line, unless an Admin allows it", async () => {
    const inserted: unknown[][] = [];
    const q = { query: async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO credit_line_draws/.test(sql)) { inserted.push(params); return { rows: [] }; }
      if (/FROM credit_lines WHERE id/.test(sql)) return { rows: [base] };
      if (/FROM credit_line_draws WHERE credit_line_id/.test(sql)) return { rows: [] };
      throw new Error("unexpected SQL: " + sql.slice(0, 60));
    } };
    const line = summarise(base, draws, "2026-11-01");
    await expect(addDraw(q, line, { amount: 200000 }, null)).rejects.toBeInstanceOf(DrawError);
    await expect(addDraw(q, { ...line, status: "expired" }, { amount: 10 }, null)).rejects.toThrow("expired");
    await addDraw(q, line, { amount: 200000, note: "approved by lender" }, null, { allowOverLimit: true });
    await addDraw(q, line, { amount: "5,000", kind: "repayment" }, null);
    expect(inserted.map((p) => [p[2], p[4]])).toEqual([["draw", 200000], ["repayment", 5000]]);
  });

  it("makes one reminder task per line and expiry date, and expires lines past their date", async () => {
    const sql: string[] = [];
    let claimed = false;
    const q = { query: async (s: string, params: unknown[] = []) => {
      sql.push(s);
      if (/SET status = 'expired'/.test(s)) return { rows: [], rowCount: 2 };
      if (/FROM credit_lines cl/.test(s)) return { rows: claimed ? [] : [base] };
      if (/FROM credit_line_draws/.test(s)) return { rows: draws.map((d) => ({ ...d, credit_line_id: base.id })) };
      if (/INSERT INTO credit_line_reminders/.test(s)) { const first = !claimed; claimed = true; return { rows: first ? [{ credit_line_id: params[0] }] : [] }; }
      if (/INSERT INTO tasks/.test(s)) { expect(String(params[2])).toContain("available 175000.00"); return { rows: [] }; }
      throw new Error("unexpected SQL: " + s.slice(0, 60));
    } };
    expect(await creditLineReminders(q, "2026-11-20")).toBe(1);
    expect(await creditLineReminders(q, "2026-11-21")).toBe(0);
    expect(sql.filter((s) => /INSERT INTO tasks/.test(s))).toHaveLength(1);
  });
});
