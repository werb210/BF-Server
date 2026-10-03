// BF_SERVER_FEE_AGREEMENT_SEND_NOW_v731
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: vi.fn(async () => ({ channel: "sms" })) }));
import { sendMediaFeeAgreementNow } from "../services/feeAgreement/mediaFeeAgreement.js";
function db(app: any, existing: any) {
  const sql: string[] = [];
  const query = vi.fn(async (text: string) => { sql.push(text); if (text.includes("FROM applications")) return { rows: app ? [app] : [] }; if (text.includes("SELECT status FROM media_fee_agreements")) return { rows: existing ? [existing] : [] }; return { rows: [], rowCount: 1 }; });
  return { query, sql };
}
const media = { id: "a1", name: "Northern Gateway Films", product_category: "MEDIA", requested_amount: 4201020, metadata: { applicant: { firstName: "Dana", lastName: "R", phone: "+14035550100" } } };
describe("staff send the media fee agreement", () => {
  it("creates it for a Media file sent by hand and notifies the client", async () => {
    const { query, sql } = db(media, null);
    expect(await sendMediaFeeAgreementNow("a1", "Bondit Media", { query })).toEqual({ ok: true, reason: "sent" });
    expect(sql.some((s) => s.startsWith("INSERT INTO media_fee_agreements"))).toBe(true);
  });
  it("re-sends while waiting, refuses signed or non-Media files", async () => {
    expect((await sendMediaFeeAgreementNow("a1", null, { query: db(media, { status: "pending" }).query })).reason).toBe("reminder_sent");
    expect((await sendMediaFeeAgreementNow("a1", null, { query: db(media, { status: "signed" }).query })).reason).toBe("already_signed");
    expect((await sendMediaFeeAgreementNow("a1", null, { query: db({ ...media, product_category: "LOC" }, null).query })).reason).toBe("not_media");
  });
});
