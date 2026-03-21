import express from "express";
import request from "supertest";
import { AppError } from "../middleware/errors";
import { errorHandler } from "../middleware/errorHandler";
import { requestId } from "../middleware/requestId";
import { requestLogger } from "../middleware/requestLogger";

type LogEntry = {
  level: "info" | "warn" | "error";
  payload: Record<string, unknown>;
};

function captureLogs(): {
  entries: LogEntry[];
  restore: () => void;
} {
  const entries: LogEntry[] = [];
  const infoSpy = vi.spyOn(console, "info").mockImplementation((message) => {
    entries.push({ level: "info", payload: JSON.parse(String(message)) });
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((message) => {
    entries.push({ level: "warn", payload: JSON.parse(String(message)) });
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    entries.push({ level: "error", payload: JSON.parse(String(message)) });
  });

  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe("request logging lifecycle", () => {
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

  it("logs start and completion with duration", async () => {
    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const { entries, restore } = captureLogs();

    const res = await request(app).get("/ok").set("x-request-id", "req-123");

    restore();

    expect(res.status).toBe(200);

    const events = entries
      .map((entry) => entry.payload.event)
      .filter(Boolean);
    expect(events).toEqual(["request_started", "request_completed"]);

    const started = entries.find(
      (entry) => entry.payload.event === "request_started"
    );
    const completed = entries.find(
      (entry) => entry.payload.event === "request_completed"
    );
    expect(started?.payload.requestId).toBe("req-123");
    expect(completed?.payload.requestId).toBe("req-123");
    expect(started?.payload.durationMs).toBe(0);
    expect(typeof completed?.payload.durationMs).toBe("number");
    expect(completed?.payload.outcome).toBe("success");
  });

  it("logs errors before completion with duration and requestId", async () => {
    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get("/boom", (_req, _res, next) => {
      next(new AppError("boom", "Boom", 500));
    });
    app.use(errorHandler);

    const { entries, restore } = captureLogs();

    const res = await request(app)
      .get("/boom")
      .set("x-request-id", "req-err");

    restore();

    expect(res.status).toBe(500);

    const orderedEvents = entries
      .map((entry) => entry.payload.event)
      .filter(Boolean);
    expect(orderedEvents).toEqual([
      "request_started",
      "request_error",
      "request_completed",
    ]);

    const errorEntry = entries.find(
      (entry) => entry.payload.event === "request_error"
    );
    const completedEntry = entries.find(
      (entry) => entry.payload.event === "request_completed"
    );
    expect(errorEntry?.payload.requestId).toBe("req-err");
    expect(completedEntry?.payload.requestId).toBe("req-err");
    expect(typeof errorEntry?.payload.durationMs).toBe("number");
    expect(typeof completedEntry?.payload.durationMs).toBe("number");
    expect(completedEntry?.payload.outcome).toBe("failure");
  });
});
