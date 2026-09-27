// BF_SERVER_BLOCK_v589_APP_FIRST
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pushToClientApp, type ClientNotice, type NotifyDeps } from "../notifyClient.js";

const n: ClientNotice = { phone: "+1 (587) 555-0100", applicationId: "a1", kind: "staff_message", sms: "", title: "t", body: "b" };
const deps = (over: Partial<NotifyDeps>): NotifyDeps => ({
  pushReady: async () => true, pushUsersForPhone: async () => ["client:+15875550100"], push: async () => 1,
  sms: vi.fn(async () => undefined), record: vi.fn(async () => undefined), ...over,
});

describe("pushToClientApp", () => {
  it("returns true and records push when the app takes it; never texts", async () => {
    const d = deps({});
    expect(await pushToClientApp(n, d)).toBe(true);
    expect(d.sms).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(n, "5875550100", { channel: "push" });
  });
  it("returns false (caller texts) with no app, push not configured, or a failed push", async () => {
    expect(await pushToClientApp(n, deps({ pushUsersForPhone: async () => [] }))).toBe(false);
    expect(await pushToClientApp(n, deps({ pushReady: async () => false }))).toBe(false);
    expect(await pushToClientApp(n, deps({ push: async () => { throw new Error("apns"); } }))).toBe(false);
    expect(await pushToClientApp({ ...n, phone: "123" }, deps({}))).toBe(false);
  });
  it("staff messages and abandoned-application reminders try the app before SMS", () => {
    const comms = readFileSync("src/routes/communications.ts", "utf8");
    expect(comms).toContain("if (stale && row?.phone && !viaApp) {");
    const worker = readFileSync("src/workers/abandonedApplicationWorker.ts", "utf8");
    expect(worker).toContain("if (!viaApp) await sendSMS(String(row.phone), ABANDON_SMS_BODY);");
  });
});
