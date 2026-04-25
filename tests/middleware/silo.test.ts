import { describe, expect, it } from "vitest";
import { siloMiddleware } from "../../src/middleware/silo.js";

function run(req: any) {
  const res: any = { locals: {} };
  let called = false;
  siloMiddleware(req, res, () => {
    called = true;
  });
  return { res, called };
}

describe("siloMiddleware", () => {
  it("single-silo user ignores X-Silo", () => {
    const { res } = run({ headers: { "x-silo": "BI" }, query: {}, user: { role: "Staff", silo: "BF", silos: ["BF"] } });
    expect(res.locals.silo).toBe("BF");
  });

  it("multi-silo user accepts allowlisted X-Silo", () => {
    const { res } = run({ headers: { "x-silo": "BI" }, query: {}, user: { role: "Staff", silo: "BF", silos: ["BF", "BI"] } });
    expect(res.locals.silo).toBe("BI");
  });

  it("multi-silo rejects non-allowlisted X-Silo", () => {
    const { res } = run({ headers: { "x-silo": "SLF" }, query: {}, user: { role: "Staff", silo: "BF", silos: ["BF", "BI"] } });
    expect(res.locals.silo).toBe("BF");
  });

  it("admin can use requested silo", () => {
    const { res } = run({ headers: { "x-silo": "SLF" }, query: {}, user: { role: "Admin", silo: "BF", silos: ["BF"] } });
    expect(res.locals.silo).toBe("SLF");
  });

  it("defaults to BF when no user", () => {
    const { res } = run({ headers: {}, query: {} });
    expect(res.locals.silo).toBe("BF");
  });

  it("invalid silo falls back", () => {
    const { res } = run({ headers: { "x-silo": "ZZ" }, query: {}, user: { role: "Staff", silo: "BI", silos: ["BI"] } });
    expect(res.locals.silo).toBe("BI");
  });
});
