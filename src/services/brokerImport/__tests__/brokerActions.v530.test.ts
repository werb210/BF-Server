// BF_SERVER_BLOCK_v530
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const query = vi.fn();
vi.mock("../../../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const sendSms = vi.fn(async () => ({ sid: "SM1" }));
vi.mock("../../../modules/notifications/sms.service.js", () => ({ sendSms: (...a: unknown[]) => sendSms(...(a as [])) }));

import { clientInviteText, discardBrokerImport, setBrokerImportPhone, textBrokerClient } from "../actions.js";

const open = { id: "i1", status: "awaiting_client", application_id: "a1", applicant_phone: "+15145550199", broker_name: "Avance", pipeline_state: "draft", first_name: "Jean" };

beforeEach(() => { query.mockReset(); sendSms.mockClear(); });

describe("v530 broker file actions", () => {
  it("sets the client's mobile on the draft and the import", async () => {
    query.mockResolvedValueOnce({ rows: [open] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    await expect(setBrokerImportPhone("i1", "(514) 555-0100")).resolves.toEqual({ applicantPhone: "+15145550100" });
    expect(String(query.mock.calls[2][0])).toContain("'readiness_phone'");
    expect(query.mock.calls[2][1]).toEqual(["a1", "+15145550100"]);
  });
  it("refuses a bad number, a number another file is waiting on, and a file the client already opened", async () => {
    await expect(setBrokerImportPhone("i1", "555")).rejects.toMatchObject({ code: "bad_phone" });
    query.mockResolvedValueOnce({ rows: [open] }).mockResolvedValueOnce({ rows: [{ id: "a2" }] });
    await expect(setBrokerImportPhone("i1", "5145550100")).rejects.toMatchObject({ code: "phone_in_use", status: 409 });
    query.mockResolvedValueOnce({ rows: [{ ...open, status: "claimed", pipeline_state: null }] });
    await expect(setBrokerImportPhone("i1", "5145550100")).rejects.toMatchObject({ code: "already_claimed" });
  });
  it("texts the client the sign-in link", async () => {
    query.mockResolvedValueOnce({ rows: [open] }).mockResolvedValue({ rows: [] });
    await expect(textBrokerClient("i1")).resolves.toEqual({ sentTo: "+15145550199" });
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+15145550199", message: expect.stringContaining("Hi Jean, Avance has sent Boreal Financial") }));
    expect(clientInviteText(null, "Avance")).toMatch(/^Hi, Avance .*https:\/\/client\.boreal\.financial$/);
  });
  it("will not text without a mobile", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...open, applicant_phone: null }] });
    await expect(textBrokerClient("i1")).rejects.toMatchObject({ code: "no_phone" });
  });
  it("discard makes the draft unclaimable and frees the number", async () => {
    query.mockResolvedValueOnce({ rows: [open] }).mockResolvedValue({ rows: [] });
    await discardBrokerImport("i1");
    expect(String(query.mock.calls[1][0])).toContain("source = 'broker_import_discarded'");
    expect(String(query.mock.calls[1][0])).toContain("- 'readiness_phone'");
    expect(String(query.mock.calls[2][0])).toContain("status = 'discarded'");
  });
  it("routes are mounted", () => {
    const r = fs.readFileSync("src/routes/brokerImports.ts", "utf8");
    expect(r).toContain('router.put("/:id/phone"');
    expect(r).toContain('router.post("/:id/text-client"');
    expect(r).toContain('router.post("/:id/discard"');
  });
});
