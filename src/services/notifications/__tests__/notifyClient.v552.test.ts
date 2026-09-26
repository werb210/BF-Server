// BF_SERVER_BLOCK_v552_NOTIFY_CLIENT
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { notifyClient, type NotifyDeps } from "../notifyClient.js";

const notice = { phone: "+1 (403) 555-0199", applicationId: "a1", kind: "term_sheet", sms: "SMS text", title: "T", body: "B" };
const deps = (over: Partial<NotifyDeps> = {}): NotifyDeps => ({
  pushReady: vi.fn(async () => true),
  pushUsersForPhone: vi.fn(async () => ["client:+14035550199"]),
  push: vi.fn(async () => 1),
  sms: vi.fn(async () => undefined),
  record: vi.fn(async () => undefined),
  ...over,
});

describe("v552 app first, SMS otherwise", () => {
  it("app installed: push, no SMS", async () => {
    const d = deps();
    expect(await notifyClient(notice, d)).toEqual({ channel: "push" });
    expect(d.pushUsersForPhone).toHaveBeenCalledWith("4035550199");
    expect(d.sms).not.toHaveBeenCalled();
  });
  it("no app on this phone: SMS", async () => {
    const d = deps({ pushUsersForPhone: vi.fn(async () => []) });
    expect(await notifyClient(notice, d)).toEqual({ channel: "sms" });
    expect(d.sms).toHaveBeenCalledWith(notice.phone, "SMS text");
  });
  it("push not configured yet: SMS without looking for devices", async () => {
    const d = deps({ pushReady: vi.fn(async () => false) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
    expect(d.pushUsersForPhone).not.toHaveBeenCalled();
  });
  it("every device refused (uninstalled app): falls back to SMS", async () => {
    const d = deps({ push: vi.fn(async () => 0) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
  });
  it("a push error still falls back to SMS", async () => {
    const d = deps({ push: vi.fn(async () => { throw new Error("apns down"); }) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
  });
  it("SMS failure is reported, never thrown, and recorded", async () => {
    const d = deps({ pushUsersForPhone: vi.fn(async () => []), sms: vi.fn(async () => { throw new Error("twilio 400"); }) });
    const r = await notifyClient(notice, d);
    expect(r.channel).toBe("none");
    expect(r.error).toContain("twilio");
    expect(d.record).toHaveBeenCalledWith(notice, "4035550199", r);
  });
  it("no usable phone: nothing sent", async () => {
    const d = deps();
    expect(await notifyClient({ ...notice, phone: "12" }, d)).toEqual({ channel: "none", error: "no_phone" });
    expect(d.sms).not.toHaveBeenCalled();
  });
  it("the client notices use it (no second push, no second SMS)", () => {
    const routes = readFileSync("src/modules/applications/applications.routes.ts", "utf-8");
    expect(routes.match(/kind: 'additional_steps'/g)?.length).toBe(1);
    expect(routes.match(/kind: 'term_sheet'/g)?.length).toBe(1);
    const portal = readFileSync("src/routes/portal.ts", "utf-8");
    expect(portal).toContain('kind: "term_sheet"');
    expect(portal).not.toContain("await sendSMS(phone, `Your term sheet");
    expect(readFileSync("src/routes/client/v1Applications.ts", "utf-8")).toContain('kind: "documents_remaining"');
    expect(readFileSync("src/routes/lenderQa.ts", "utf-8")).toContain('kind: "lender_questions"');
  });
});
