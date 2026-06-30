// BF_SERVER_BLOCK_CALL_CONTACT_RESOLVE_v1 — resolution order regression test.
import { describe, expect, it, vi } from "vitest";
import { resolveCallContactId } from "../voiceCalls.js";

const base = { contactId: null, applicationId: null, toPstn: "", silo: "BF" };

describe("resolveCallContactId", () => {
  it("returns explicit contactId without querying", async () => {
    const q = vi.fn();
    expect(await resolveCallContactId(q as any, { ...base, contactId: "c1" })).toBe("c1");
    expect(q).not.toHaveBeenCalled();
  });
  it("falls back to application's crm_contact_id", async () => {
    const q = vi.fn().mockResolvedValueOnce({ rows: [{ crm_contact_id: "c2" }] });
    expect(await resolveCallContactId(q as any, { ...base, applicationId: "a1" })).toBe("c2");
  });
  it("falls back to phone match when no contact/app contact", async () => {
    const q = vi.fn()
      .mockResolvedValueOnce({ rows: [{ crm_contact_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "c3" }] });
    expect(await resolveCallContactId(q as any, { ...base, applicationId: "a1", toPstn: "+16475326400" })).toBe("c3");
  });
  it("returns null when nothing resolves (no auto-create)", async () => {
    const q = vi.fn().mockResolvedValue({ rows: [] });
    expect(await resolveCallContactId(q as any, { ...base, toPstn: "+15550000000" })).toBeNull();
  });
});
