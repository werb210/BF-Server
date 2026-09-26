// BF_SERVER_BLOCK_v538_CREDIT_SUMMARY_V2
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
const query = vi.fn();
vi.mock("../../../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const table = { periods: [{ label: "FY2023", periodEnd: null, kind: "annual" }, { label: "FY2024", periodEnd: null, kind: "annual" }], rows: [{ item: "revenue", values: [17654361, 11556700] }, { item: "inventory", values: [3000000, 3350000] }, { item: "dscr", values: [2.1, 1.8] }] };
vi.mock("../financials.js", () => ({ loadFinancialTable: vi.fn(async () => table) }));
vi.mock("../collateral.js", () => ({ loadCollateral: vi.fn(async () => ({ receivables: { total: 2350000, over_90: 621000 }, payables: null, equipment: { items: [], count: 0, total: null }, realEstate: { properties: [], equity: null } })) }));
vi.mock("../research.js", () => ({ loadResearch: vi.fn(async () => ({ facts: [
  { id: "1", source: "website", status: "reported", label: "From the company website", value: "Downhole tool services in Nisku, AB.", url: "https://propipecanada.com" },
  { id: "2", source: "web", status: "unverified", label: "Lawsuit", value: "Unconfirmed claim", url: "https://x.example" },
] })) }));
vi.mock("../../../routes/crm/timeline.js", () => ({ loadCrmTimeline: vi.fn(async () => []) }));
const create = vi.fn();
import OpenAI from "openai";
import { applyEdit, buildOverview, dealTypeFor, generateSummaryV2, mergeKeepingEdits, missingInfo, unsupportedAmounts } from "../creditSummaryV2.js";
const proPipe = { id: "a1", name: "Pro-Pipe", requested_amount: 5000000, product_category: "ASSET_BASED_LENDING", contact_id: null, silo: "BF",
  metadata: { business: { legalName: "Pro-Pipe Service & Sales Ltd.", address: "1507 7th Street", city: "Nisku", state: "AB", website: "https://www.propipecanada.com" }, applicant: { firstName: "Dan", lastName: "Porodo" }, kyc: { industry: "Oilfield Service" } } };
beforeEach(() => {
  process.env.OPENAI_API_KEY = "k"; query.mockReset(); query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM applications")) return { rows: [{ a: proPipe }] }; if (sql.includes("FROM documents")) return { rows: [{ n: 2 }] }; return { rows: [], rowCount: 1 };
  });
  create.mockReset(); vi.mocked(OpenAI as any).mockImplementation(function () { return { chat: { completions: { create } } }; });
});
describe("v538 deal type and overview table (built in code)", () => {
  it("maps categories", () => { expect(dealTypeFor("EQUIPMENT_FINANCE")).toBe("equipment"); expect(dealTypeFor("ASSET_BASED_LENDING")).toBe("abl"); expect(dealTypeFor("TERM_LOAN")).toBe("term"); });
  it("builds ABL overview", () => { const o = buildOverview(proPipe, "abl", { receivables: { total: 2350000 }, realEstate: {} }, table as any);
    expect(o).toMatchObject({ applicant_name: "Pro-Pipe Service & Sales Ltd.", principals: "Dan Porodo", assets: "A/R & Inventory", asset_value: "A/R: $2,350,000, Inventory: $3,350,000", facility_request: "$5,000,000", ltv: "88%", transaction: "ABL/LOC" }); });
  it("builds equipment overview", () => { const o = buildOverview({ requested_amount: 1515000, product_category: "EQUIPMENT_FINANCE", metadata: {} }, "equipment", { equipment: { count: 7, total: 1515000 }, realEstate: { equity: 1260000 } }, { periods: [], rows: [] }); expect(o.asset_value).toBe("$1,515,000"); expect(o.ltv).toBe("100%"); expect(o.additional_security).toContain("$1,260,000"); });
});
describe("v538 safeguards", () => {
  it("flags invented figures", () => { const known = [2350000, 621000, 5000000]; expect(unsupportedAmounts("A/R of $2.35MM with $621M; request $5,000,000.", known)).toEqual([]); expect(unsupportedAmounts("Forecast $21.5MM and $7.77MM.", known)).toEqual(["$21.5MM", "$7.77MM"]); });
  it("lists missing information", () => { const m = missingInfo("abl", { requested_amount: 0, metadata: {} }, { periods: [], rows: [] }, { receivables: null }, [{ status: "unverified" }], false); expect(m).toEqual(expect.arrayContaining(["No facility amount on the application.", expect.stringContaining("No financial statements"), expect.stringContaining("No accounts receivable aging"), "No bank statements or banking analysis."])); });
});
describe("v538 generate", () => {
  it("uses checked research and flags unsupported amounts", async () => { create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ transaction: "Request $5.0MM.", overview: "Nisku operator.", deal_section: "A/R $2.35MM and $621M over 90.", financial_commentary: "Revenue $11,556,700; forecast $21.5MM.", rationale: ["Experienced"], risks: [] }) } }] });
    const doc = await generateSummaryV2("a1"); const prompt = String((create.mock.calls[0] as any[])[0].messages[1].content); expect(prompt).toContain("Downhole tool services"); expect(prompt).not.toContain("Unconfirmed claim"); expect(doc.warnings).toEqual(["Financial Summary: $21.5MM is not in the source figures - check it."]); expect(doc.unverifiedResearch[0]?.id).toBe("2"); });
});
describe("v538 staff edits", () => {
  const base: any = { version: 2, overview: { term: "TBD" }, sections: [{ key: "overview", title: "Overview", text: "AI text" }, { key: "rationale", title: "Rationale", text: "", bullets: ["a"] }] };
  it("keeps edits", () => { let doc = applyEdit(base, "overview", { text: "Staff text" }); doc = applyEdit(doc, "overview_table", { term: "60M", ltv: "90%" }); const fresh: any = { ...base, overview: { term: "TBD", ltv: "TBD" }, sections: [{ key: "overview", title: "Overview", text: "New" }, { key: "rationale", title: "Rationale", text: "", bullets: ["b"] }] }; const merged = mergeKeepingEdits(doc, fresh); expect(merged.sections[0]).toMatchObject({ text: "Staff text", edited: true }); expect(merged.overview).toMatchObject({ term: "60M", ltv: "90%" }); });
  it("rejects unknown sections", () => expect(() => applyEdit(base, "nope", {})).toThrow("unknown_section"));
  it("mounts route and stamps user", () => { expect(fs.readFileSync("src/routes/routeRegistry.ts", "utf8")).toMatch(/path: "\/credit-summary-v2", router: creditSummaryV2Routes/); expect(fs.readFileSync("src/services/credit/creditSummaryV2.ts", "utf8")).toContain("SELECT first_name, last_name, email FROM users"); });
});
