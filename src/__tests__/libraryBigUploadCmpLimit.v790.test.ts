// BF_SERVER_LIBRARY_BIG_UPLOAD_v790 / BF_SERVER_CMP_READ_LIMIT_v790 / BF_SERVER_SBA_OWNER1_EMAIL_v790
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const sba = vi.hoisted(() => ({
  owners: [] as any[],
  crmEmail: null as string | null,
  embeddedInvite: vi.fn(async () => ({ inviteId: "inv-1" })),
  sendSms: vi.fn(async () => undefined),
  sendTransactional: vi.fn(async () => ({ ok: true, status: 202 })),
}));

vi.mock("../middleware/auth.js", async (orig) => {
  const real: any = await orig();
  return { ...real, requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u1", role: "Staff" }; next(); } };
});
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = answerBySql([
    [/FROM staff_library/, { rows: [{ drive_id: "D1", item_id: "ROOT", share_url: "https://share/lib" }] }],
    // SBA signing: an SBA deal with every form in.
    [/FROM lender_submissions/, { rows: [{ n: "1" }] }],
    [/SELECT doc_type, owner_fingerprint FROM application_form_responses/, { rows: [{ doc_type: "sba_form_1919", owner_fingerprint: null }, { doc_type: "sba_form_413", owner_fingerprint: null }] }],
  ]);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: async () => ({
    accessToken: "t",
    fetch: async (path: string) => path.includes("/createUploadSession")
      ? new Response(JSON.stringify({ uploadUrl: "https://boreal-my.sharepoint.com/upload/abc" }), { status: 200 })
      : new Response("{}", { status: 200 }),
  }),
}));
// SBA signing collaborators: SignNow, the PDF builders and the notifiers.
vi.mock("../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<any>()),
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: async (_b: unknown, filename: string) => ({ documentId: "doc-" + filename }),
  createDocumentGroup: async () => ({ groupId: "grp-1" }),
  createEmbeddedGroupInvite: sba.embeddedInvite,
  createEmbeddedGroupLink: async (_g: string, _i: string, email: string) => ({ url: "https://signnow.test/link?for=" + email }),
  sendGroupEmailInvite: async () => ({ inviteId: "inv-email" }),
}));
vi.mock("../signnow/sba/sbaOwners.js", async (orig) => ({
  ...(await orig<any>()),
  resolveSbaOwners: async () => sba.owners,
  loadSbaContext: async () => ({ business: {}, kyc: {}, form1919: {}, form413ByOwner: new Map() }),
}));
vi.mock("../signnow/sba/sbaFormBuilder.js", () => ({
  buildSba1919: async () => new Uint8Array([1]),
  buildSba912: async () => null,
  buildSba413: async () => null,
  buildSba4506c: async () => null,
}));
vi.mock("../signnow/sendApplicationForSignature.js", () => ({ loadApplicationForPdf: async () => ({}) }));
vi.mock("../signnow/pdfBuilder.js", () => ({ buildApplicationPdf: async () => new Uint8Array([2]) }));
vi.mock("../services/clientEmail.js", () => ({
  crmContactEmail: async () => sba.crmEmail,
  resolveClientEmail: async () => ({ email: sba.crmEmail, firstName: "Dana" }),
}));
vi.mock("../services/notifications/notifyClient.js", () => ({ pushToClientApp: async () => false }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: sba.sendSms }));
vi.mock("../services/sendgridService.js", async (orig) => ({ ...(await orig<any>()), sendTransactional: sba.sendTransactional }));

import o365, { isOneDriveUploadUrl, LIBRARY_CHUNK_BYTES } from "../routes/o365.js";
import { createApp } from "../app.js";
import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/o365", o365);
const MB = 1024 * 1024;

beforeEach(() => { vi.restoreAllMocks(); });

describe("Staff Library uploads up to 200 MB", () => {
  it("opens a OneDrive upload session for a 150 MB file", async () => {
    const r = await request(app).post("/api/o365/library/upload-session").send({ name: "Boreal Staff Portal Setup 1.0.1.exe", size: 150 * MB });
    expect(r.status).toBe(200);
    expect(r.body.uploadUrl).toBe("https://boreal-my.sharepoint.com/upload/abc");
    expect(r.body.chunkBytes % (320 * 1024)).toBe(0);
    expect(r.body.maxBytes).toBe(200 * MB);
  });
  it("refuses over 200 MB with a clear message", async () => {
    const r = await request(app).post("/api/o365/library/upload-session").send({ name: "big.exe", size: 200 * MB + 1 });
    expect(r.status).toBe(413);
    expect(r.body.message).toContain("200 MB");
  });
  it("passes each piece straight to OneDrive with the right byte range", async () => {
    const put = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    const piece = Buffer.alloc(LIBRARY_CHUNK_BYTES, 1);
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-url", "https://boreal-my.sharepoint.com/upload/abc")
      .set("x-chunk-start", "0").set("x-total-size", String(12 * MB))
      .send(piece);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: false, next: LIBRARY_CHUNK_BYTES });
    expect((put.mock.calls[0]![1] as any).headers["Content-Range"]).toBe("bytes 0-" + (LIBRARY_CHUNK_BYTES - 1) + "/" + 12 * MB);
  });
  it("returns the file once the last piece lands", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "X1", name: "Setup.exe", webUrl: "https://od/X1", size: 10 }), { status: 201 }));
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream")
      .set("x-upload-url", "https://boreal-my.sharepoint.com/upload/abc")
      .set("x-chunk-start", "0").set("x-total-size", "10")
      .send(Buffer.alloc(10, 1));
    expect(r.body).toMatchObject({ done: true, item: { id: "X1", name: "Setup.exe" } });
  });
  it("never forwards to anything but OneDrive", async () => {
    expect(isOneDriveUploadUrl("https://evil.example.com/x")).toBe(false);
    expect(isOneDriveUploadUrl("http://boreal-my.sharepoint.com/x")).toBe(false);
    const r = await request(app).post("/api/o365/library/upload-chunk")
      .set("Content-Type", "application/octet-stream").set("x-upload-url", "https://169.254.169.254/latest")
      .set("x-chunk-start", "0").set("x-total-size", "1").send(Buffer.alloc(1));
    expect(r.status).toBe(400);
  });
});

describe("the browser is allowed to send upload pieces cross-origin", () => {
  it("CORS allows the three upload headers (staff.boreal.financial -> server.boreal.financial)", async () => {
    const r = await request(createApp())
      .options("/api/o365/library/upload-chunk")
      .set("Origin", "https://staff.boreal.financial")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-upload-url,x-chunk-start,x-total-size,content-type");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("https://staff.boreal.financial");
    const allowed = String(r.headers["access-control-allow-headers"]).toLowerCase().split(",").map((s) => s.trim());
    for (const h of ["x-upload-url", "x-chunk-start", "x-total-size"]) expect(allowed).toContain(h);
  });
});

describe("the client portal is not starved by the site-wide limiter", () => {
  const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

  // A client read behind the read limiter (an unknown path: the router answers 404).
  const READ = "/api/client/__no_such_read";

  // Each test comes from its own address, so the router's separate per-IP poll limiter never interferes.
  function clientApp() {
    const a = express();
    a.set("trust proxy", true);
    a.use(express.json());
    a.use("/api/client", clientRouter);
    return a;
  }

  it("client reads have their own ceiling of 120 a minute, counted per signed-in client", async () => {
    const a = clientApp();
    const ip = "198.51.100.1";
    const mine = token("+15875550123");
    for (let i = 0; i < 120; i += 1) {
      const r = await request(a).get(READ).set("X-Forwarded-For", ip).set("Authorization", mine);
      expect(r.status).not.toBe(429);
    }
    const over = await request(a).get(READ).set("X-Forwarded-For", ip).set("Authorization", mine);
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "RATE_LIMITED" });
    // Another client behind the same IP has their own budget (the old limiter was one budget per IP).
    const other = await request(a).get(READ).set("X-Forwarded-For", ip).set("Authorization", token("+15875550199"));
    expect(other.status).not.toBe(429);
  });

  it("without a session the ceiling is per IP", async () => {
    const a = clientApp();
    for (let i = 0; i < 120; i += 1) await request(a).get(READ).set("X-Forwarded-For", "198.51.100.2");
    expect((await request(a).get(READ).set("X-Forwarded-For", "198.51.100.2")).status).toBe(429);
    expect((await request(a).get(READ).set("X-Forwarded-For", "198.51.100.3")).status).not.toBe(429);
  });

  it("writes are not counted against the read ceiling", async () => {
    const a = clientApp();
    const ip = "198.51.100.4";
    const mine = token("+15875553333");
    for (let i = 0; i < 121; i += 1) await request(a).post(READ).set("X-Forwarded-For", ip).set("Authorization", mine).send({});
    const r = await request(a).get(READ).set("X-Forwarded-For", ip).set("Authorization", mine);
    expect(r.status).not.toBe(429);
  });
});

describe("owner 1 is only told to sign when the signing exists", () => {
  const APP = "a1";
  beforeEach(() => {
    sba.embeddedInvite.mockClear();
    sba.sendSms.mockClear();
    sba.sendTransactional.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses the CRM email for owner 1 before skipping", async () => {
    const { createSbaSigningSessions } = await import("../signnow/sba/sbaSigning.js");
    sba.owners = [{ index: 1, fullName: "Dana Owner", email: "", phone: "4035550100" }];
    sba.crmEmail = "dana@crm.example";
    const out = await createSbaSigningSessions(APP, { includeApplication: true });
    expect(out).toEqual([{ ownerIndex: 1, name: "Dana Owner", email: "dana@crm.example", url: "https://signnow.test/link?for=dana@crm.example" }]);
    expect(sba.embeddedInvite).toHaveBeenCalledWith("grp-1", expect.any(Array), [expect.objectContaining({ email: "dana@crm.example", roleName: "Owner 1" })]);

    sba.crmEmail = null;
    sba.embeddedInvite.mockClear();
    const skipped = await createSbaSigningSessions(APP, { includeApplication: true });
    expect(skipped).toEqual([{ ownerIndex: 1, name: "Dana Owner", email: "", url: null }]);
    expect(sba.embeddedInvite).not.toHaveBeenCalled();
  });

  it("does not text or email owner 1 when their signing was not created", async () => {
    const { sendSbaForSigning } = await import("../signnow/sba/sbaTrigger.js");
    sba.owners = [{ index: 1, fullName: "Dana Owner", email: "", phone: "4035550100" }];
    sba.crmEmail = null;
    const out = await sendSbaForSigning(APP);
    expect(out.ok).toBe(false);
    expect(out.notice).toEqual({ sms: false, email: false });
    expect(sba.sendSms).not.toHaveBeenCalled();
    expect(sba.sendTransactional).not.toHaveBeenCalled();
  });

  it("texts and emails owner 1 once the signing exists", async () => {
    const { sendSbaForSigning } = await import("../signnow/sba/sbaTrigger.js");
    sba.owners = [{ index: 1, fullName: "Dana Owner", email: "dana@x.example", phone: "4035550100" }];
    sba.crmEmail = "dana@x.example";
    const out = await sendSbaForSigning(APP);
    expect(out.ok).toBe(true);
    expect(out.notice).toMatchObject({ sms: true, email: true });
    expect(sba.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "4035550100" }));
    expect(sba.sendTransactional).toHaveBeenCalledWith(expect.objectContaining({ to: "dana@x.example" }));
  });
});
