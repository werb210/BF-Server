// BF_SERVER_TEST_SEND_NAME_COLUMN_v29
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/routes/marketing.ts", "utf8");
const seg = src.slice(src.indexOf("async function testSendVars"), src.indexOf('router.post("/email/send"'));

describe("testSendVars", () => {
  it("selects contacts.name, the column the CRM shows and the blast merges from", () => {
    const selects = seg.match(/SELECT c.name, c.first_name, c.last_name/g) || [];
    expect(selects.length).toBe(2);
  });

  it("prefers name and falls back to first_name and last_name when it is blank", () => {
    expect(seg).toContain('const full = String(row.name || "").trim() || split;');
  });

  it("still falls back to the literal when nothing matches at all", () => {
    expect(seg).toContain('"there"');
  });

  it("keeps the silo filter on both lookups", () => {
    expect((seg.match(/c\.silo = \$1/g) || []).length).toBe(2);
  });
});

// BF_SERVER_CI_GREEN_AND_NAME_PRECEDENCE_v30
describe("name precedence", () => {
  it("prefers contacts.name outright, matching the live send", () => {
    const src = readFileSync("src/routes/marketing.ts", "utf8");
    expect(src).toContain('const full = String(row.name || "").trim() || split;');
  });

  it("still derives first_name from the resolved full name", () => {
    const src = readFileSync("src/routes/marketing.ts", "utf8");
    expect(src).toContain("first_name: full.split(/\\s+/)[0]");
  });
});

describe("parity with the live send path", () => {
  it("marketingSendRunner still merges from c.name", () => {
    const runner = readFileSync("src/services/marketingSendRunner.ts", "utf8");
    expect(runner).toContain('(c.name || "").trim().split(/\\s+/)[0] || "there"');
  });
});
