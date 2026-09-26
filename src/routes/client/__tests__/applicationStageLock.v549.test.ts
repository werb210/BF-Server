// BF_SERVER_BLOCK_v549_LOCK_APPLICATION_STAGE
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const src = readFileSync("src/routes/client/index.ts", "utf-8");
describe("v549 application-stage answers only the owner", () => {
  it("checks ownership before reading the file", () => {
    const at = src.indexOf('"/application-stage"');
    const body = src.slice(at, at + 2000);
    const own = body.indexOf("callerOwnsApplication(req, applicationId)");
    const read = body.indexOf("select pipeline_state, status, metadata from applications");
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(read);
    expect(body).toContain("res.status(404).json({ found: false })");
  });
});
