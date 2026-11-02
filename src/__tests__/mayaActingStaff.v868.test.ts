// BF_SERVER_v868_MAYA_ACTING_STAFF - Maya's staff tools act only as the staff member named in the X-Maya-Context
// this server signed: a different staff_user_id or silo is refused with 403, a verified one replaces whatever the
// body said, and an unsigned or forged context names nobody.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router, type Request } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { actingStaffFromRequest, mayaActingStaff } from "../services/mayaActingStaff.js";
import { signMayaContext } from "../services/mayaContext.js";
import { signServiceToken } from "../auth/serviceTokens.js";
import { verifyMayaService } from "../routes/mayaStaff.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const SECRET = "v868-acting-staff-secret";

function req(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { body, header: (name: string) => h[name.toLowerCase()] } as unknown as Request;
}
const ctx = (id: string, silo = "BF") => signMayaContext({ audience: "staff", staff: { id, name: null, email: null, role: "Staff" } as any, silo: silo as any });
const service = () => `Bearer ${signServiceToken("bf-server", { source: "agent" })}`;

function app() {
  const seen: Array<Record<string, unknown>> = [];
  const maya = Router();
  maya.use("/staff", mayaActingStaff((r) => Boolean(verifyMayaService(r))));
  maya.post("/staff/send-sms", (r, res) => { seen.push({ ...r.body }); res.json({ ok: true }); });
  const a = express();
  a.use(express.json());
  a.use("/api/maya", maya);
  return { a, seen };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
  vi.restoreAllMocks();
});

describe("the assistant's acting staff member", () => {
  it("comes from the context this server signed", () => {
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1) }, { staff_user_id: U1 }))).toEqual({ id: U1, silo: "BF", mismatch: false });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1, "BI") }))).toEqual({ id: U1, silo: "BI", mismatch: false });
  });

  it("a different staff_user_id or silo is a mismatch", () => {
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1) }, { staff_user_id: U2 })).mismatch).toBe("staff");
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1, "BI") }, { staff_user_id: U1, silo: "SLF" })).mismatch).toBe("silo");
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1, "BI") }, { silo: "bi" })).mismatch).toBe(false);
  });

  it("an unsigned, wrongly signed, wrong-audience, client or service token names nobody", () => {
    expect(actingStaffFromRequest(req({}, { staff_user_id: U1 }))).toEqual({ id: null, silo: null, mismatch: false });
    const forged = jwt.sign({ kind: "maya_context", audience: "staff", staff: { id: U1 } }, "other-secret", { issuer: "bf-server", audience: "agent" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": forged }, { staff_user_id: U2 })).id).toBeNull();
    const wrongAud = jwt.sign({ kind: "maya_context", audience: "staff", staff: { id: U1 } }, SECRET, { issuer: "bf-server", audience: "bf-server" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": wrongAud })).id).toBeNull();
    const client = signMayaContext({ audience: "client", phone: "+17805550100", silo: "BF" } as any);
    expect(actingStaffFromRequest(req({ "X-Maya-Context": client })).id).toBeNull();
    const svc = jwt.sign({ kind: "service", audience: "staff", staff: { id: U1 } }, SECRET, { issuer: "bf-server", audience: "agent" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": svc })).id).toBeNull();
  });
});

describe("/api/maya/staff/* with an agent service token", () => {
  it("answers 403 when the agent names a different staff member, and the handler never runs", async () => {
    const { a, seen } = app();
    const r = await request(a).post("/api/maya/staff/send-sms").set("Authorization", service()).set("X-Maya-Context", ctx(U1))
      .send({ staff_user_id: U2, to: "+15875550100", body: "hi" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("staff_identity_mismatch");
    expect(seen).toHaveLength(0);
  });

  it("answers 403 when the agent names another silo", async () => {
    const { a, seen } = app();
    const r = await request(a).post("/api/maya/staff/send-sms").set("Authorization", service()).set("X-Maya-Context", ctx(U1, "BF"))
      .send({ staff_user_id: U1, silo: "BI" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("staff_silo_mismatch");
    expect(seen).toHaveLength(0);
  });

  it("hands the handler the verified staff member and silo", async () => {
    const { a, seen } = app();
    const r = await request(a).post("/api/maya/staff/send-sms").set("Authorization", service()).set("X-Maya-Context", ctx(U1, "SLF"))
      .send({ to: "+15875550100", body: "hi" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ staff_user_id: U1, silo: "SLF" });
  });

  it("an agent without a context still works (logged), so the old agent keeps running until it is updated", async () => {
    const { a, seen } = app();
    const r = await request(a).post("/api/maya/staff/send-sms").set("Authorization", service()).send({ staff_user_id: U2, body: "hi" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ staff_user_id: U2 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("without a signed context"), expect.anything());
  });

  it("leaves a request without a service token to the route's own checks", async () => {
    const { a, seen } = app();
    const r = await request(a).post("/api/maya/staff/send-sms").set("X-Maya-Context", ctx(U1)).send({ staff_user_id: U2 });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ staff_user_id: U2 });
  });
});
