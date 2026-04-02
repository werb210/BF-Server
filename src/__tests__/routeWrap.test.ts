import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { wrap } from "../lib/routeWrap";

function createMockRes(): Response & { body?: unknown; statusCode?: number } {
  const res = {
    headersSent: false,
    locals: {},
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  } as Response & { body?: unknown; statusCode?: number };

  return res;
}

describe("routeWrap handling", () => {
  it("returns consistent error shape for thrown errors", async () => {
    const handler = wrap(async () => {
      throw Object.assign(new Error("BROKEN_HANDLER"), { status: 418 });
    });

    const req = {} as Request;
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      status: "error",
      error: "BROKEN_HANDLER",
    });
  });

  it("returns status ok with data when handler resolves undefined", async () => {
    const handler = wrap(async () => undefined);

    const req = {} as Request;
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      data: undefined,
    });
  });

  it("returns wrapped data payload for successful responses", async () => {
    const handler = wrap(async () => ({ ok: true }));

    const req = {} as Request;
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      data: { ok: true },
    });
  });
});
