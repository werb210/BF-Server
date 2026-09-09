// BF_SERVER_ENROLL_CROSS_SILO_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const engine = fs.readFileSync(path.resolve(__dirname, "../sequenceEngine.ts"), "utf8");

describe("named enrollment", () => {
  it("no longer drops a contact for being in another silo", () => {
    expect(engine).not.toContain("WHERE c.id = ANY($4::uuid[]) AND c.silo=$2");
  });

  it("still requires a way to reach them", () => {
    expect(engine).toContain("COALESCE(c.email,'')<>'' OR COALESCE(c.phone,'')<>''");
  });

  it("leaves bulk audience enrollment silo-scoped", () => {
    expect(engine).toContain("WHERE c.silo=$2");
  });
});
