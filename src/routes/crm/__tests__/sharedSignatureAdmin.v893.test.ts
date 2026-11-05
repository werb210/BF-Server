// BF_SERVER_v893_SHARED_SIGNATURE_ADMIN - only an Admin sets a shared mailbox's signature.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: () => {} }) },
  dbQuery: h.query,
}));

const app = async () => mountRouter((await import("../../crm.js")).default, "/api/crm");
const put = async (role: "Admin" | "Staff") =>
  request(await app()).put("/api/crm/shared-mailboxes/sales%40example.test/signature")
    .set({ Authorization: `Bearer ${staffToken(role)}` }).send({ signature_html: "<p>Sales</p>" });

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([
    [/SELECT 1 FROM shared_mailbox_settings/, { rowCount: 1, rows: [{ "?column?": 1 }] }],
    [/UPDATE shared_mailbox_settings SET signature_html/, { rowCount: 1, rows: [] }],
  ]));
});

describe("shared mailbox signature", () => {
  it("refuses Staff and changes nothing", async () => {
    const r = await put("Staff");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("admin_only");
    expect(h.query.mock.calls.some((c) => /UPDATE shared_mailbox_settings/.test(String(c[0])))).toBe(false);
  });

  it("lets an Admin save it", async () => {
    const r = await put("Admin");
    expect(r.status).toBe(200);
    expect(h.query.mock.calls.some((c) => /UPDATE shared_mailbox_settings/.test(String(c[0])))).toBe(true);
  });
});
