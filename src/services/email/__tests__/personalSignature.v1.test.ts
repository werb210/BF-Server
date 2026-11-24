// BF_SERVER_SILO_SIGNATURES_v1 - answers by SQL content, not call order.
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../db.js", () => ({ pool: { query: vi.fn() } }));
import { personalSignatureHtml, savePersonalSignatureHtml } from "../personalSignature.js";

const db = (row: any) => ({ query: vi.fn(async (sql: string) => (sql.includes("FROM user_settings") ? { rows: row ? [row] : [] } : { rows: [] })) });

describe("personal signature per business", () => {
  it("Boreal Financial uses the existing signature; Keystone its own and never the Boreal one", async () => {
    const d = db({ email_signature_html: "<p>BF</p>", by_silo: { KS: "<p>KS</p>" } });
    expect(await personalSignatureHtml("u1", "BF", d)).toBe("<p>BF</p>");
    expect(await personalSignatureHtml("u1", "ks", d)).toBe("<p>KS</p>");
    expect(await personalSignatureHtml("u1", "BI", d)).toBe("");
    expect(await personalSignatureHtml("u1", "KS", db(null))).toBe("");
  });
  it("saves Keystone into the per-business map", async () => {
    const d = db(null);
    await savePersonalSignatureHtml("u1", "KS", "<p>K</p>", d);
    const [sql, params] = d.query.mock.calls[0]!;
    expect(sql).toContain("email_signatures_by_silo");
    expect(params).toEqual(["u1", "KS", "<p>K</p>"]);
  });
});
