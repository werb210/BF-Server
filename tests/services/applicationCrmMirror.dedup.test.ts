// BF_SERVER_v70_BLOCK_1_3
import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("applicationCrmMirror dedup strategy", () => {
  const src = fs.readFileSync("src/services/applicationCrmMirror.ts", "utf8");

  it("includes the v70_BLOCK_1_3 sentinel", () => {
    expect(src).toContain("BF_SERVER_v70_BLOCK_1_3");
  });

  it("matches companies by email lowercased first", () => {
    expect(src).toMatch(/lower\(email\)\s*=\s*\$2/);
    expect(src).toMatch(/businessEmail\s*=.*toLowerCase/);
  });

  it("falls through to phone match before name match", () => {
    const emailIdx = src.indexOf("lower(email) = $2");
    const phoneIdx = src.indexOf("WHERE silo = $1 AND phone = $2");
    const nameIdx  = src.indexOf("lower(trim(name)) = lower(trim($2))");
    expect(emailIdx).toBeGreaterThan(-1);
    expect(phoneIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeLessThan(phoneIdx);
    expect(phoneIdx).toBeLessThan(nameIdx);
  });

  it("INSERT path now includes email column", () => {
    expect(src).toMatch(/INSERT INTO companies[\s\S]+id, name, email, phone/);
  });

  it("UPDATE path now sets email", () => {
    expect(src).toMatch(/UPDATE companies SET[\s\S]+email\s*=\s*COALESCE/);
  });
});
