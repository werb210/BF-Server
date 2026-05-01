// BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE
import { describe, it, expect, vi } from "vitest";
import { notifyAllStaff } from "../notifyAllStaff.js";

describe("BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — INSERT carries title", () => {
  it("uses provided title verbatim", async () => {
    const inserts: any[][] = [];
    const pool: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO notifications")) {
          inserts.push(params!);
          return { rows: [] };
        }
        if (typeof sql === "string" && sql.includes("FROM users")) {
          return { rows: [{ id: "u1", phone_number: null, email: null }] };
        }
        return { rows: [] };
      }),
    };
    await notifyAllStaff({
      pool,
      notificationType: "website_readiness",
      title: "Custom Title",
      body: "anything",
    });
    expect(inserts.length).toBe(1);
    // params order: user.id, type, title, ref_table, ref_id, body, context_url
    expect(inserts[0][2]).toBe("Custom Title");
  });

  it("falls back to humanized notificationType if no title given", async () => {
    const inserts: any[][] = [];
    const pool: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO notifications")) {
          inserts.push(params!);
          return { rows: [] };
        }
        if (typeof sql === "string" && sql.includes("FROM users")) {
          return { rows: [{ id: "u1", phone_number: null, email: null }] };
        }
        return { rows: [] };
      }),
    };
    await notifyAllStaff({
      pool,
      notificationType: "website_readiness",
      body: "anything",
    });
    expect(inserts[0][2]).toBe("Website Readiness");
  });
});
