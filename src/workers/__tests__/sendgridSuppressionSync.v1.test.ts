// BF_SERVER_UNIVERSAL_SUPPRESSION_v1
import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock } }));

import { syncSendgridSuppressions, SUPPRESSION_KINDS } from "../sendgridSuppressionSync.js";

const lists: Record<string, any[]> = {
  "/v3/suppression/unsubscribes": [{ email: "A@x.test" }],
  "/v3/suppression/spam_reports": [],
  "/v3/suppression/bounces": [{ email: "hard@x.test", status: "5.1.1" }, { email: "soft@x.test", status: "4.2.0" }],
  "/v3/asm/suppressions": [{ email: "group@x.test", group_id: 1 }, { email: "otherbrand@x.test", group_id: 2 }],
};
const fetchMock = vi.fn(async (url: string) => {
  const path = new URL(url).pathname;
  return new Response(JSON.stringify(lists[path] ?? []), { status: 200 });
}) as unknown as typeof fetch;

afterEach(() => { queryMock.mockReset(); delete process.env.SENDGRID_API_KEY; delete process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID; });

describe("SendGrid suppression sync", () => {
  it("does nothing without a SendGrid key", async () => {
    expect(await syncSendgridSuppressions(fetchMock)).toEqual({ checked: 0, added: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("copies unsubscribes, permanent bounces and group unsubscribes, then opts the contacts out", async () => {
    process.env.SENDGRID_API_KEY = "test-key";
    process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID = "1"; // only Boreal Financial's own group counts
    queryMock.mockImplementation(async (sql: string) => ({ rows: [], rowCount: /INSERT INTO email_suppressions/.test(sql) ? 1 : 0 }));
    const r = await syncSendgridSuppressions(fetchMock);
    expect(SUPPRESSION_KINDS.map((k) => k.path)).toContain("/v3/asm/suppressions");
    const inserts = queryMock.mock.calls.filter(([sql]) => /INSERT INTO email_suppressions/.test(sql));
    expect(inserts.map(([, p]) => p)).toEqual([[["a@x.test"], "unsubscribe", null], [["hard@x.test"], "bounce", null], [["group@x.test"], "group_unsubscribe", ["BF"]]]);
    expect(queryMock.mock.calls.some(([sql]) => /UPDATE contacts c SET marketing_opt_out = true/.test(sql))).toBe(true);
    expect(r).toEqual({ checked: 3, added: 3 });
  });
});
