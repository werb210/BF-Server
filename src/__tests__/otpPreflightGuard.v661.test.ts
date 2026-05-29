import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const app = readFileSync("src/app.ts", "utf-8");

describe("v661 OTP preflight guard", () => {
  it("short-circuits OPTIONS for /api/auth/* with 204 after cors()", () => {
    expect(app).toContain("BF_SERVER_BLOCK_v661");
    expect(app).toMatch(/app\.options\(\/\^\\\/api\\\/auth\\\/\/, cors\(corsOptions\)/);
    expect(app).toContain("res.sendStatus(204)");
  });
  it("keeps the catch-all options handler ahead of the json body parser", () => {
    const optionsIdx = app.indexOf('app.options("*", cors(corsOptions));');
    const jsonIdx = app.indexOf("express.json(");
    expect(optionsIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(optionsIdx);
  });
});
