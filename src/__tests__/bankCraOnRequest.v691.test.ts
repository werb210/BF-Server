// BF_SERVER_BANK_CRA_ON_REQUEST_v691
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Connect Bank and CRA Authorization only when staff request them", () => {
  it("submit no longer requests them automatically", () => {
    expect(readFileSync("src/routes/client/v1Applications.ts", "utf8")).toContain('if (hit && (hit[1] === "flinks" || hit[1] === "cra")) continue;');
  });
  it("old automatic prompts (no staff name) are ignored everywhere they are read", () => {
    const auto = "NOT (staff_name IS NULL AND cta_action IN ('cra','flinks','form:cra','form:flinks'))";
    expect(readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8")).toContain(auto);
    expect(readFileSync("src/modules/applications/applications.routes.ts", "utf8")).toContain(auto);
    expect(readFileSync("src/routes/client/index.ts", "utf8")).toContain('r.staff_name == null && ["cra", "flinks", "form:cra", "form:flinks"]');
  });
});
