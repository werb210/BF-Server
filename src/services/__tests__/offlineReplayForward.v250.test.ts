// BF_SERVER_OFFLINE_REPLAY_v250
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { forwardReplayAction, isForwardableReplayPath } from "../offlineReplayForward.js";

const ID = "11111111-2222-4333-8444-555555555555";
const ok = (status: number, body: unknown) => vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));

describe("which offline actions may be replayed", () => {
  it("allows only additive staff actions", () => {
    expect(isForwardableReplayPath(`/api/crm/contacts/${ID}/notes`)).toBe(true);
    expect(isForwardableReplayPath(`/api/crm/companies/${ID}/notes`)).toBe(true);
    expect(isForwardableReplayPath("/api/tasks")).toBe(true);
    expect(isForwardableReplayPath(`/api/tasks/${ID}/complete`)).toBe(true);
    expect(isForwardableReplayPath("/api/telephony/calls/CA0123abcd/disposition")).toBe(true);
  });
  it("refuses edits, money, submissions and anything unlisted", () => {
    expect(isForwardableReplayPath(`/api/applications/${ID}`)).toBe(false);
    expect(isForwardableReplayPath(`/api/applications/${ID}/stage`)).toBe(false);
    expect(isForwardableReplayPath("/api/lender/send")).toBe(false);
    expect(isForwardableReplayPath(`/api/crm/contacts/${ID}/notes/../../users`)).toBe(false);
    expect(isForwardableReplayPath("/api/tasks?x=1")).toBe(false);
  });
});

describe("forwarding", () => {
  it("calls the live route on this server as the caller, with silo", async () => {
    const f = ok(201, { status: "ok", data: { id: "n1" } });
    const r = await forwardReplayAction({ path: `/api/crm/contacts/${ID}/notes`, body: { body: "Called, left VM" } },
      { authorization: "Bearer abc", silo: "BI" }, f as any, 8080);
    expect(r).toEqual({ statusCode: 201, body: { status: "ok", data: { id: "n1" } } });
    const [url, init] = (f.mock.calls[0] as any);
    expect(url).toBe(`http://127.0.0.1:8080/api/crm/contacts/${ID}/notes`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer abc");
    expect(init.headers["x-silo"]).toBe("BI");
    expect(JSON.parse(init.body)).toEqual({ body: "Called, left VM" });
  });
  it("turns a refused action into a failed result the client can show", async () => {
    await expect(forwardReplayAction({ path: `/api/tasks/${ID}/complete`, body: {} },
      { authorization: "Bearer abc" }, ok(404, { error: { code: "not_found" } }) as any, 8080))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });
  it("never forwards without the caller's own authorization", async () => {
    await expect(forwardReplayAction({ path: "/api/tasks", body: {} }, { authorization: "" }, ok(201, {}) as any, 8080))
      .rejects.toMatchObject({ status: 401 });
  });
});

describe("wiring", () => {
  it("the replay service tries the forwarder first and the route passes the caller context", () => {
    const svc = fs.readFileSync("src/services/pwaSyncService.ts", "utf8");
    expect(svc).toContain("return forwardReplayAction(action, forward);");
    expect(svc).toContain("params.forward");
    expect(fs.readFileSync("src/routes/pwa.ts", "utf8")).toContain("forward: {");
  });
});
