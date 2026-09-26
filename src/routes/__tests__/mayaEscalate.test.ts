// BF_SERVER_BLOCK_v576 - rewritten for today's /api/maya/escalate: talk_to_human attaches to a
// CRM contact and reuses the contact's open messenger thread (v686); report_issue keeps the
// screenshot as a data URL on the issue (v645) and lives only in the Issues tab (v763).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, createContactMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createContactMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../services/contacts.js", () => ({ createContact: createContactMock }));
vi.mock("../../services/notifications/staffSms.js", () => ({ sendStaffNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/staffNotifyService.js", () => ({ notifyStaffSMS: vi.fn().mockResolvedValue(undefined) }));

type Row = Record<string, unknown>;
function routeSql(rowsFor: (sql: string) => Row[]) {
  queryMock.mockImplementation(async (sql: string) => ({ rows: rowsFor(String(sql)) }));
}
const calls = (re: RegExp) => queryMock.mock.calls.filter((c: any[]) => re.test(String(c[0])));

describe("mayaEscalate", () => {
  beforeEach(() => {
    queryMock.mockReset();
    createContactMock.mockReset();
    createContactMock.mockResolvedValue({ id: "k-new" });
  });
  async function app() {
    const r = (await import("../mayaEscalate.js")).default;
    const a = express(); a.use(express.json({ limit: "10mb" })); a.use("/api", r); return a;
  }

  it("talk_to_human attaches to the existing contact and opens a thread", async () => {
    routeSql((sql) => {
      if (/FROM contacts/.test(sql)) return [{ id: "k1" }];
      if (/INSERT INTO communications_conversations/.test(sql)) return [{ id: "c1" }];
      return [];
    });
    const res = await request(await app()).post("/api/maya/escalate")
      .send({ kind: "talk_to_human", message: "help", contact: { name: "Jane Doe", phone: "(587) 555-0100" } });
    expect(res.status).toBe(201);
    expect(res.body.conversation_id).toBe("c1");
    const msg = calls(/INSERT INTO communications_messages/)[0];
    expect(msg?.[1]?.slice(0, 2)).toEqual(["c1", "k1"]);
    expect(createContactMock).not.toHaveBeenCalled();
  });

  it("talk_to_human reuses the contact's open messenger thread", async () => {
    routeSql((sql) => {
      if (/FROM contacts/.test(sql)) return [{ id: "k1" }];
      if (/SELECT id FROM communications_conversations/.test(sql)) return [{ id: "c-open" }];
      return [];
    });
    const res = await request(await app()).post("/api/maya/escalate")
      .send({ kind: "talk_to_human", message: "help", contact: { name: "Jane Doe", phone: "+15875550100" } });
    expect(res.status).toBe(201);
    expect(res.body.conversation_id).toBe("c-open");
    expect(calls(/INSERT INTO communications_conversations/)).toHaveLength(0);
  });

  it("talk_to_human without name+channel returns need_identity and creates nothing", async () => {
    const res = await request(await app()).post("/api/maya/escalate").send({ kind: "talk_to_human", message: "help", contact: {} });
    expect(res.status).toBe(422); expect(res.body.need_identity).toBe(true); expect(queryMock).not.toHaveBeenCalled();
  });

  it("talk_to_human with name but no channel returns need_identity", async () => {
    const res = await request(await app()).post("/api/maya/escalate").send({ kind: "talk_to_human", message: "help", contact: { name: "Jane" } });
    expect(res.status).toBe(422); expect(res.body.missing.channel).toBe(true);
  });

  it("report_issue stores the screenshot on the issue and posts nothing to Messages", async () => {
    routeSql((sql) => {
      if (/INSERT INTO communications_conversations/.test(sql)) return [{ id: "c9" }];
      if (/INSERT INTO issues/.test(sql)) return [{ id: "i1" }];
      return [];
    });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const res = await request(await app()).post("/api/maya/escalate").send({ kind: "report_issue", description: "broken", screenshot_data_url: png });
    expect(res.status).toBe(201);
    expect(res.body.issue_id).toBe("i1");
    expect(calls(/INSERT INTO issues/)[0][1]).toContain(png);
    expect(calls(/INSERT INTO communications_messages/)).toHaveLength(0);
  });

  it("rejects missing kind", async () => {
    const res = await request(await app()).post("/api/maya/escalate").send({});
    expect(res.status).toBe(400);
  });
});
