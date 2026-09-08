// BF_SERVER_SERVICE_PRINCIPAL_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mw = fs.readFileSync(path.resolve(__dirname, "../auth.ts"), "utf8");

describe("auth middleware surfaces the service principal", () => {
  it("reads the principal claim", () => {
    expect(mw).toContain('decodedAny.principal === "service"');
  });

  it("exposes the flags downstream writers need", () => {
    for (const field of ["isServicePrincipal", "serviceName", "actorResolved"]) {
      expect(mw).toContain(field);
    }
  });

  it("still pins the verification algorithm", () => {
    // BF_SERVER_JWT_HARDENING_v1 must survive this change.
    expect(mw).toContain('algorithms: ["HS256"]');
  });
});
