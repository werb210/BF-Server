// BF_SERVER_v898_YOUR_SERVICES
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVendorKeys, resetVendorKeysForTests, saveVendorKeys, sealingKey, unseal, VendorKeyError, viewOf } from "../vendorKeys.js";

function memoryDb() {
  const rows = new Map<string, { key: string; value_enc: string; key_name: string }>();
  return {
    rows,
    async query(sql: string, p: unknown[] = []) {
      if (/^SELECT key, value_enc, key_name FROM vendor_keys/.test(sql)) return { rows: [...rows.values()] };
      if (/^DELETE FROM vendor_keys/.test(sql)) { rows.delete(String(p[0])); return { rows: [] }; }
      if (/^\s*INSERT INTO vendor_keys/.test(sql)) { rows.set(String(p[0]), { key: String(p[0]), value_enc: String(p[1]), key_name: String(p[2]) }); return { rows: [] }; }
      throw new Error("unexpected sql " + sql);
    },
  } as any;
}

beforeEach(() => { resetVendorKeysForTests(); delete process.env.IPINFO_TOKEN; });
afterEach(() => { resetVendorKeysForTests(); });

describe("Your services (vendor keys)", () => {
  it("stores encrypted, applies to the environment, masks, and removes", async () => {
    const db = memoryDb();
    const out = await saveVendorKeys(db, { IPINFO_TOKEN: " tok_998877 ", ONFIDO_REGION: "CA" }, "u1");
    const row = db.rows.get("IPINFO_TOKEN")!;
    expect(row.value_enc).not.toContain("tok_998877");
    expect(unseal(row.value_enc, sealingKey()!.key)).toBe("tok_998877");
    expect(process.env.IPINFO_TOKEN).toBe("tok_998877");
    expect(viewOf(out).find((v) => v.key === "IPINFO_TOKEN")).toMatchObject({ set: true, preview: "••••8877" });
    expect(viewOf(out).find((v) => v.key === "ONFIDO_REGION")).toMatchObject({ preview: "ca" });
    await saveVendorKeys(db, { IPINFO_TOKEN: null }, "u1");
    expect(process.env.IPINFO_TOKEN).toBeUndefined();
  });

  it("refuses unknown names and a bad region; a reload picks saved keys up", async () => {
    const db = memoryDb();
    await expect(saveVendorKeys(db, { JWT_SECRET: "x" }, null)).rejects.toBeInstanceOf(VendorKeyError);
    await expect(saveVendorKeys(db, { ONFIDO_REGION: "mars" }, null)).rejects.toBeInstanceOf(VendorKeyError);
    await saveVendorKeys(db, { CORPORATIONS_CANADA_API_KEY: "ck_1" }, null);
    delete process.env.CORPORATIONS_CANADA_API_KEY;
    await loadVendorKeys(db);
    expect(process.env.CORPORATIONS_CANADA_API_KEY).toBe("ck_1");
  });
});
