// BF_SERVER_v969_CALLER_ID_PER_BUSINESS
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callerIdForCall, clearSiloLineCache, listSiloLines, setSiloLineNumber, siloLineNumber } from "../voice/directLines.js";

function db(settings: Record<string, string>, directNumber: string | null) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^SELECT value FROM settings/.test(sql)) { const v = settings[String(params[0])]; return { rows: v ? [{ value: v }] : [] }; }
    if (/INSERT INTO settings/.test(sql)) { settings[String(params[0])] = String(params[1]); return { rows: [] }; }
    if (/DELETE FROM settings/.test(sql)) { delete settings[String(params[0])]; return { rows: [] }; }
    if (/direct_number FROM users/.test(sql)) return { rows: [{ direct_number: directNumber }] };
    return { rows: [] };
  });
  return { query };
}
beforeEach(() => { clearSiloLineCache(); delete process.env.TWILIO_MAIN_LINE_NUMBER; });

describe("the number an outgoing call shows", () => {
  it("a business with its own line shows that line, whoever is calling", async () => {
    const q = db({ "silo_line.BI": "+18885550142" }, "+18254511768");
    expect(await callerIdForCall(q, "u1", "BI")).toBe("+18885550142");
    expect(await callerIdForCall(q, "u1", "bi")).toBe("+18885550142");
  });
  it("Boreal Financial, and a business with no line, keep the staff rule: direct number, else the 866", async () => {
    const q = db({ "silo_line.BI": "+18885550142" }, "+18254511768");
    expect(await callerIdForCall(q, "u1", "BF")).toBe("+18254511768");
    expect(await callerIdForCall(q, "u1", "KS")).toBe("+18254511768");
    expect(await callerIdForCall(db({}, null), "u1", "KS")).toBe("+18666318939");
    expect(await siloLineNumber(q, "BF")).toBeNull();
  });
  it("a line can be set, changed and removed; a bad number or unknown business is refused", async () => {
    const store: Record<string, string> = {};
    const q = db(store, null);
    expect(await setSiloLineNumber(q, "ks", "(888) 555-0177")).toEqual({ silo: "KS", number: "+18885550177" });
    expect(await callerIdForCall(q, "u1", "KS")).toBe("+18885550177");
    expect(await listSiloLines(q)).toEqual([{ silo: "BI", number: null }, { silo: "SLF", number: null }, { silo: "KS", number: "+18885550177" }]);
    await setSiloLineNumber(q, "KS", "");
    expect(await callerIdForCall(q, "u1", "KS")).toBe("+18666318939");
    await expect(setSiloLineNumber(q, "KS", "12")).rejects.toThrow("invalid_number");
    await expect(setSiloLineNumber(q, "BF", "+18885550177")).rejects.toThrow("unknown_business");
  });
  it("a lookup that fails falls back to the staff rule instead of failing the call", async () => {
    const q = { query: vi.fn(async (sql: string) => { if (/FROM settings/.test(sql)) throw new Error("db down"); return { rows: [{ direct_number: "+18254511768" }] }; }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await callerIdForCall(q, "u1", "BI")).toBe("+18254511768");
    warn.mockRestore();
  });
});
