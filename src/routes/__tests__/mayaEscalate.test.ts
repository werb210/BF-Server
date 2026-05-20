import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock, uploadMock } = vi.hoisted(() => ({ queryMock: vi.fn(), uploadMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../lib/azureBlob.js", () => ({ uploadBufferToBlob: uploadMock }));
vi.mock("../../services/staffNotifyService.js", () => ({ notifyStaffSMS: vi.fn().mockResolvedValue(undefined) }));

describe("mayaEscalate", () => {
  beforeEach(() => { queryMock.mockReset(); uploadMock.mockReset(); });
  async function app() { const r = (await import("../mayaEscalate.js")).default; const a = express(); a.use(express.json({limit:"10mb"})); a.use("/api", r); return a; }
  it("talk_to_human creates conversation and message", async () => {
    queryMock.mockResolvedValueOnce({ rows:[{id:"c1"}] }).mockResolvedValueOnce({ rows:[] });
    const res = await request(await app()).post("/api/maya/escalate").send({ kind:"talk_to_human", message:"help", contact:{ phone:"+1" }});
    expect(res.status).toBe(201); expect(res.body.conversation_id).toBe("c1"); expect(queryMock).toHaveBeenCalledTimes(2);
  });
  it("report_issue uploads screenshot and inserts issue", async () => {
    uploadMock.mockResolvedValue({ url:"https://blob/u.png", blobName:"u.png" });
    queryMock.mockResolvedValueOnce({ rows:[{id:"i1"}] });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const res = await request(await app()).post("/api/maya/escalate").send({ kind:"report_issue", description:"broken", screenshot_data_url: png });
    expect(res.status).toBe(201); expect(res.body.issue_id).toBe("i1"); expect(uploadMock).toHaveBeenCalled();
  });
  it("rejects missing kind", async () => {
    const res = await request(await app()).post("/api/maya/escalate").send({});
    expect(res.status).toBe(400);
  });
});
