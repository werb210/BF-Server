import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/client/submitAttempts.ts", import.meta.url)), "utf-8");

describe("generate_lead attribution", () => {
  it("passes the real ga client id and gclid into the conversion", () => {
    expect(src).toContain("req.body?.ga_client_id");
    expect(src).toContain("req.body?.gclid");
    expect(src).toContain("gaClientId");
    expect(src).not.toContain('void sendGa4Event("generate_lead", { currency: "CAD", value: 100 });');
  });
});
