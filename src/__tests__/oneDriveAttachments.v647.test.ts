// BF_SERVER_ONEDRIVE_ATTACHMENTS_v647
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { attachmentFolder, cleanPart, drivePath } from "../services/o365/oneDriveFolders.js";

const h = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: any }>, driveStatus: 201 }));
vi.mock("../db.js", () => ({ pool: {} }));
vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: vi.fn(async () => ({
    accessToken: "t",
    fetch: vi.fn(async (path: string, init?: any) => {
      h.calls.push({ path, init });
      const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path.includes("?$select=subject")) return json({ subject: "Re: After our Call", from: { emailAddress: { name: "Vit Kanesh", address: "vit@frontierfunding.ca" } }, receivedDateTime: "2026-09-28T19:02:25Z" });
      if (path.endsWith("isInline")) return json({ value: [{ id: "a1", name: "Agreement.pdf" }, { id: "logo", name: "logo.png", isInline: true }] });
      if (path.includes("/attachments/a1")) return json({ name: "Agreement.pdf", contentType: "application/pdf", contentBytes: Buffer.from("%PDF-1").toString("base64") });
      if (init?.method === "PUT") return h.driveStatus === 201 ? json({ name: "Agreement.pdf", webUrl: "https://od/Agreement.pdf" }, 201) : json({ error: {} }, h.driveStatus);
      if (path.startsWith("/me/drive/root:/")) return json({ webUrl: "https://od/folder" });
      return json({}, 404);
    }),
  })),
}));

import inboxRouter from "../routes/crm/inbox.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: "u1" }; next(); });
  a.use("/inbox", inboxRouter);
  return a;
}

beforeEach(() => { h.calls = []; h.driveStatus = 201; });

describe("OneDrive folder naming", () => {
  it("Email Attachments / sender / date - subject", () => {
    expect(attachmentFolder({ senderName: "Vit Kanesh", receivedAt: "2026-09-28T19:02:25Z", subject: "Re: After our Call" }))
      .toBe("Email Attachments/Vit Kanesh/2026-09-28 - Re After our Call");
  });
  it("removes characters OneDrive refuses and falls back sensibly", () => {
    expect(cleanPart('A/B:C*D?"E<F>G|H#I%. ', "x")).toBe("A B C D E F G H I");
    expect(attachmentFolder({ senderAddress: "x@y.com", subject: "" })).toBe("Email Attachments/x@y.com/undated - No subject");
    expect(drivePath("Email Attachments/Vit Kanesh", "a b.pdf")).toBe("Email%20Attachments/Vit%20Kanesh/a%20b.pdf");
  });
});

describe("POST /inbox/:id/attachments/save-to-onedrive", () => {
  it("saves each real attachment (not inline images) into the folder", async () => {
    const r = await request(app()).post("/inbox/m1/attachments/save-to-onedrive");
    expect(r.status).toBe(200);
    const body = r.body.data ?? r.body;
    expect(body.folder).toBe("Email Attachments/Vit Kanesh/2026-09-28 - Re After our Call");
    expect(body.saved).toEqual([{ name: "Agreement.pdf", webUrl: "https://od/Agreement.pdf" }]);
    expect(body.folderUrl).toBe("https://od/folder");
    const put = h.calls.find((c) => c.init?.method === "PUT")!;
    expect(put.path).toBe("/me/drive/root:/Email%20Attachments/Vit%20Kanesh/2026-09-28%20-%20Re%20After%20our%20Call/Agreement.pdf:/content?@microsoft.graph.conflictBehavior=rename");
    expect(h.calls.some((c) => c.path.includes("/attachments/logo"))).toBe(false);
  });
  it("asks to reconnect when OneDrive permission is missing", async () => {
    h.driveStatus = 403;
    const r = await request(app()).post("/inbox/m1/attachments/save-to-onedrive");
    expect(r.status).toBe(412);
    expect(r.body.error).toBe("onedrive_permission_needed");
  });
});
