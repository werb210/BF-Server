// BF_SERVER_APPLICANT_PUSH_v235
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ apnsSend: vi.fn(), fcmSend: vi.fn() }));
import { __setClientPushProvider, sendClientPush } from "../clientPushService.js";
import { __setFcmProvider } from "../fcmProvider.js";
import { pool } from "../../db.js";
const query = vi.spyOn(pool, "query") as unknown as ReturnType<typeof vi.fn>;
describe("v235 client push routing", () => {
  beforeEach(() => { query.mockReset(); h.apnsSend.mockReset().mockResolvedValue(undefined); h.fcmSend.mockReset().mockResolvedValue(undefined); __setClientPushProvider({ send: h.apnsSend } as any); __setFcmProvider({ send: h.fcmSend } as any); });
  it("sets iOS category and link", async () => { query.mockResolvedValue({ rows: [{ token: "ios", platform: "ios" }] }); await sendClientPush({ userId: "u", title: "T", body: "B", categoryId: "DOCUMENT_REQUEST", url: "borealclient://documents", data: { applicationId: "a1" } }); const payload = h.apnsSend.mock.calls[0][1]; expect(payload.aps.category).toBe("DOCUMENT_REQUEST"); expect(payload.url).toBe("borealclient://documents"); expect(payload.applicationId).toBe("a1"); });
  it("sets Android routing data", async () => { query.mockResolvedValue({ rows: [{ token: "and", platform: "android" }] }); await sendClientPush({ userId: "u", title: "T", body: "B", categoryId: "OFFER_READY", url: "borealclient://application/a1" }); const payload = h.fcmSend.mock.calls[0][1]; expect(payload.data.categoryId).toBe("OFFER_READY"); expect(payload.data.url).toBe("borealclient://application/a1"); });
  it("omits optional iOS category", async () => { query.mockResolvedValue({ rows: [{ token: "ios", platform: "ios" }] }); await sendClientPush({ userId: "u", title: "T", body: "B" }); expect("category" in h.apnsSend.mock.calls[0][1].aps).toBe(false); });
});
