import request from "supertest";
import { app } from "../src";

describe("lenders route error logging", () => {
  let originalTestLogging: string | undefined;

  beforeEach(() => {
    originalTestLogging = process.env.TEST_LOGGING;
    process.env.TEST_LOGGING = "true";
  });

  afterEach(() => {
    if (originalTestLogging === undefined) {
      delete process.env.TEST_LOGGING;
    } else {
      process.env.TEST_LOGGING = originalTestLogging;
    }
  });

  it("returns existing error shape and logs stack with request id", async () => {
    const requestId = "lenders-trace-req";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app || require("../src/app").default)
      .get("/api/lenders/__test-error")
      .set("x-request-id", requestId);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      requestId,
    });

    const errorLogs = errorSpy.mock.calls.map((call) => String(call[0]));
    const matched = errorLogs.find(
      (message) =>
        message.includes(requestId) &&
        (message.includes("stack") || message.includes("Error:"))
    );
    expect(matched).toBeTruthy();

    errorSpy.mockRestore();
  });
});
