// BF_SERVER_v789_MAYA_PROXY_SCOPE - the proxy forwards an application id only when the caller may see it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;
const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEIRS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params?: unknown[]) => {
    if (/FROM users WHERE id::text = \$1/.test(sql)) {
      if (params?.[0] === STAFF_ID) {
        return { rows: [{ id: STAFF_ID, first_name: "Sam", last_name: "Staff", email: "sam@boreal.test", role: "Staff", silo: "BF", silos: ["BF"] }] };
      }
      return { rows: [] };
    }
    if (/FROM app_phones WHERE p10 = \$2/.test(sql)) {
      if (params?.[0] === MINE) return { rows: [{ total: 1, mine: 1, known: 1 }] };
      if (params?.[0] === THEIRS) return { rows: [{ total: 1, mine: 0, known: 1 }] };
      return { rows: [{ total: 0, mine: 0, known: 0 }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query };
});
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: async () => undefined }));

import mayaRoutes, { MAYA_PROXY_TIMEOUT_MS } from "../routes/maya.js";

const app = express();
app.use(express.json());
app.use("/api/maya", mayaRoutes);

const staffTok = "Bearer " + jwt.sign({ id: STAFF_ID, sub: STAFF_ID, role: "Staff" }, SECRET, { algorithm: "HS256" });
const clientTok = "Bearer " + jwt.sign({ sub: "client:+17805550100", role: "client", isClient: true, phone: "+17805550100" }, SECRET, { algorithm: "HS256" });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.MAYA_URL = "http://maya.test";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "hi" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MAYA_URL;
});

function lastBody(): any {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, any];
  return JSON.parse(init.body);
}

describe("v789 Maya proxy application scoping", () => {
  it("client keeps an id for their own application", async () => {
    await request(app).post("/api/maya/message").set("Authorization", clientTok).send({ message: "hi", application_id: MINE, applicationId: MINE });
    expect(lastBody()).toEqual({ message: "hi", application_id: MINE, applicationId: MINE });
  });

  it("client loses an id for someone else's application, or one that does not exist", async () => {
    await request(app).post("/api/maya/message").set("Authorization", clientTok).send({ message: "hi", application_id: THEIRS, applicationId: MINE });
    expect(lastBody()).toEqual({ message: "hi", applicationId: MINE });
    await request(app).post("/api/maya/chat").set("Authorization", clientTok).send({ message: "hi", applicationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", application_id: 42 });
    expect(lastBody()).toEqual({ message: "hi" });
  });

  it("public callers never forward an application id", async () => {
    await request(app).post("/api/maya/message").send({ message: "hi", application_id: MINE, applicationId: MINE });
    expect(lastBody()).toEqual({ message: "hi" });
  });

  it("staff keep the application id they sent", async () => {
    await request(app).post("/api/maya/message").set("Authorization", staffTok).send({ message: "hi", application_id: THEIRS });
    expect(lastBody()).toEqual({ message: "hi", application_id: THEIRS });
  });

  it("the agent gets 25 s (it budgets 22 s)", async () => {
    expect(MAYA_PROXY_TIMEOUT_MS).toBe(25_000);
    const timers = vi.spyOn(globalThis, "setTimeout");
    await request(app).post("/api/maya/message").set("Authorization", staffTok).send({ message: "hi" });
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, any];
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).not.toContain(10_000);
    const abortTimer = timers.mock.calls.find((c) => c[1] === MAYA_PROXY_TIMEOUT_MS);
    expect(abortTimer).toBeDefined();
    (abortTimer![0] as () => void)(); // the deadline firing is what aborts the upstream call
    expect(signal.aborted).toBe(true);
    timers.mockRestore();
  });
});
