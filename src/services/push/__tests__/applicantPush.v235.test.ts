// BF_SERVER_APPLICANT_PUSH_v235
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../../../db.js";
import { __resetApplicantPushDedupe, __setApplicantPushSender, applicantDeepLink, applicantPushUserIds, notifyApplicant } from "../applicantPush.js";
const APP = "11111111-2222-4333-8444-555555555555";
const send = vi.fn();
describe("BF_SERVER_APPLICANT_PUSH_v235", () => {
  const query = vi.spyOn(pool, "query") as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => { query.mockReset(); send.mockReset().mockResolvedValue({ sent: 1, skipped: 0, unsupported: 0 }); __resetApplicantPushDedupe(); __setApplicantPushSender(send as any); });
  it("builds client links", () => {
    expect(applicantDeepLink("DOCUMENT_REQUEST", APP)).toBe("borealclient://documents");
    expect(applicantDeepLink("OFFER_READY", APP)).toBe(`borealclient://application/${APP}`);
    expect(applicantDeepLink("APPLICATION_UPDATE", "")).toBe("borealclient://home");
  });
  it("resolves client token subjects by phone", async () => {
    query.mockResolvedValue({ rows: [{ user_id: "client:+15875550100" }] });
    expect(await applicantPushUserIds(APP)).toEqual(["client:+15875550100"]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("application_contacts"); expect(sql).toContain("client_push_tokens"); expect(sql).toContain("LIKE 'client:%'"); expect(sql).not.toMatch(/applications\.user_id|SELECT user_id FROM applications/); expect(params).toEqual([APP]);
  });
  it("does not throw when lookup fails", async () => { const error = vi.spyOn(console, "error").mockImplementation(() => {}); query.mockRejectedValue(new Error("boom")); expect(await applicantPushUserIds(APP)).toEqual([]); expect(error).toHaveBeenCalled(); error.mockRestore(); });
  it("sends routing to every applicant", async () => { query.mockResolvedValue({ rows: [{ user_id: "client:+1" }, { user_id: "client:+2" }] }); expect((await notifyApplicant({ applicationId: APP, categoryId: "DOCUMENT_REQUEST", title: "T", body: "B" })).sent).toBe(2); expect(send).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "DOCUMENT_REQUEST", url: "borealclient://documents", data: { applicationId: APP } })); });
  it("deduplicates events", async () => { query.mockResolvedValue({ rows: [{ user_id: "client:+1" }] }); const input = { applicationId: APP, categoryId: "OFFER_READY" as const, title: "T", body: "B", dedupeKey: "o1" }; await notifyApplicant(input); await notifyApplicant(input); expect(send).toHaveBeenCalledTimes(1); });
});
