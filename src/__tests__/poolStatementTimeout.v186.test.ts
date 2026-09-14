// BF_SERVER_POOL_STATEMENT_TIMEOUT_v186
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/db.prod.ts", "utf-8");

describe("pool statement_timeout", () => {
  it("is a pool option, not a query on the connect event", () => {
    expect(src).not.toMatch(/pool\.on\(\s*["']connect["']/);
    expect(src).not.toContain('SET statement_timeout');
  });

  it("is set on both pool config paths", () => {
    expect(src.match(/statement_timeout: 10_000/g)?.length).toBe(2);
  });

  it("never issues an unawaited client.query anywhere in this module", () => {
    expect(src).not.toMatch(/void\s+client\s*[\r\n\s]*\.query/);
  });
});
