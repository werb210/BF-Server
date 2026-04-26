import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, runQueryMock } = vi.hoisted(() => ({ queryMock: vi.fn(), runQueryMock: vi.fn() }));

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: queryMock }, runQuery: runQueryMock };
});

describe("portal lender delete logging", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
    runQueryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: "00000000-0000-0000-0000-000000000001", role: "admin", silo: "BF", silos: ["BF"] }] });
  });

  function token() {
    return jwt.sign({ id: "00000000-0000-0000-0000-000000000001", role: "admin" }, "test-secret");
  }

  async function app() {
    const router = (await import("../portalLenders.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/portal", router);
    return app;
  }

  it("returns 500 and logs structured error on FK violation", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runQueryMock.mockRejectedValue({ code: "23503", message: "fk", detail: "still referenced" });
    const res = await request(await app())
      .delete("/api/portal/lenders/11111111-1111-4111-8111-111111111111")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("23503");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("returns 204 and logs success", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    runQueryMock.mockResolvedValue({ rowCount: 1 });
    const res = await request(await app())
      .delete("/api/portal/lenders/11111111-1111-4111-8111-111111111111")
      .set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(204);
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});
