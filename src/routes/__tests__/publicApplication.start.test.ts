import { beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /api/public/application/start (Block 13)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("falls back to canonical system UUID when config is null", async () => {
    const dbQueryMock = vi.fn();
    const createApplicationMock = vi.fn();

    const newAppId = "0cf36dc9-429b-42ff-9222-64bbe69b6155";
    createApplicationMock.mockResolvedValue({ id: newAppId });

    vi.doMock("../../db.js", () => ({ dbQuery: dbQueryMock, pool: { query: dbQueryMock } }));
    vi.doMock("../../modules/applications/applications.repo.js", () => ({
      createApplication: createApplicationMock,
    }));
    vi.doMock("../../middleware/silo.js", () => ({ getSilo: () => "BF" }));
    vi.doMock("../../config/index.js", () => ({
      config: {
        client: {
          // Simulate the production misconfig — env var unset.
          submissionOwnerUserId: null as string | null,
        },
      },
    }));

    const mod = await import("../publicApplication.js");
    const router = mod.default ?? (mod as any).router;
    expect(router).toBeTruthy();

    const layer = (router.stack ?? []).find(
      (l: any) => l?.route?.path === "/application/start" && l.route.methods?.post
    );
    expect(layer).toBeTruthy();
    const handler = layer.route.stack[0].handle;

    // BF_PUBAPP_RES_WRITE_v32_TEST — capture res.json() body, not handler return.
    let jsonBody: any = undefined;
    let statusCode = 200;
    const req: any = { body: {} };
    const res: any = {
      locals: { silo: "BF" },
      status(code: number) { statusCode = code; return res; },
      json(body: unknown) { jsonBody = body; return res; },
      headersSent: false,
    };
    const next = (err: unknown) => {
      if (err) throw err;
    };

    await handler(req, res, next);

    expect(createApplicationMock).toHaveBeenCalledTimes(1);
    const callArgs = createApplicationMock.mock.calls[0][0];
    expect(callArgs.ownerUserId).toBe("00000000-0000-0000-0000-000000000001");
    expect(statusCode).toBe(200);
    expect((jsonBody as any)?.data?.applicationId).toBe(newAppId);
  });
});
