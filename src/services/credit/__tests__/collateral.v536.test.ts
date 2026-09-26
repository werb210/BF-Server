// BF_SERVER_BLOCK_v536_COLLATERAL_EXTRACTION
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
import { agingSummary, equipmentSummary, normalizeAging, normalizeEquipment, normalizeRealEstate, realEstateSummary, xlsxToText } from "../collateral.js";

function makeZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const body = Buffer.from(f.data); const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("v536 collateral", () => {
  it("calculates receivables eligibility and concentration", () => {
    const a = normalizeAging({ as_of: "2025-03-31", total: "2,350,000", buckets: { over_90: 621000 }, customers: [{ name: "Cenovus", total: 900000, over_90: 0 }, { name: "NOV", total: 500000, over_90: 100000 }, { name: "Slow Payer Ltd", total: 400000, over_90: 300000 }, { name: "Others", total: 550000, over_90: 221000 }, { name: "", total: 5 }] });
    const s = agingSummary(a); expect(s.over_90_pct).toBe(26.4); expect(s.top_customer).toEqual({ name: "Cenovus", total: 900000, pct: 38.3 }); expect(s.cross_aged).toEqual(["Slow Payer Ltd"]); expect(s.eligible).toBe(1629000);
  });
  it("calculates equipment totals", () => {
    const e = normalizeEquipment({ vendor: "Oxford", items: [{ year: 2020, make: "Claas", price: "$450,000" }, { make: "Claas", model: "Head", price: 210000 }, { make: "Claas", model: "Pickup", price: 400000 }, { make: "Arts Way", price: 45000 }, { make: "Arts Way", price: 45000 }, { make: "New Holland", price: 265000 }, { make: "Claas", price: 100000 }, { year: "n/a" }] });
    expect(equipmentSummary([e])).toMatchObject({ count: 7, total: 1515000 });
  });
  it("calculates real estate equity", () => expect(realEstateSummary([normalizeRealEstate({ properties: [{ address: "Oxford County", value: "2,660,000", mortgage_balance: 1400000 }] })]).equity).toBe(1260000));
  it("reads an xlsx worksheet", () => {
    const xlsx = makeZip([{ name: "xl/sharedStrings.xml", data: '<sst><si><t>Customer</t></si><si><t>Total</t></si><si><t>Cenovus &amp; Co</t></si></sst>' }, { name: "xl/worksheets/sheet1.xml", data: '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c><v>900000</v></c></row></sheetData></worksheet>' }]);
    expect(xlsxToText(xlsx)).toBe("Customer\tTotal\nCenovus & Co\t900000");
  });
  it("mounts the route and preserves staff corrections", () => {
    expect(fs.readFileSync("src/routes/routeRegistry.ts", "utf8")).toMatch(/path: "\/credit-collateral", router: creditCollateralRoutes/);
    expect(fs.readFileSync("src/services/credit/collateral.ts", "utf8")).toContain("WHERE application_collateral.extracted_by = 'ai'");
  });
});
