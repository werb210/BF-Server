// BF_SERVER_CALL_PHONE_v765
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { firstPhone } from "../modules/applications/applications.routes.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});

const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = () => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

function detailsRow(contactPhone: string | null, metadata: Record<string, unknown>) {
  return { id: APP_ID, name: "Acme", silo: "BF", metadata, finalized_lenders: 0, signnow_app_signed_at: null, contact_phone: contactPhone };
}

beforeEach(() => { queryMock.mockReset(); });

describe("the number the portal dials for Call client", () => {
  it("takes the first value that is a real phone number", () => {
    expect(firstPhone("+1 403 555 0199", "4035550111")).toBe("+1 403 555 0199");
    expect(firstPhone(null, "", "12", "403-555-0111")).toBe("403-555-0111");
    expect(firstPhone(undefined, null)).toBeNull();
  });

  it("the details endpoint reads the CRM contact's phone and puts it first", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM applications a WHERE a\.id::text/, { rows: [detailsRow("+1 780 555 0100", { applicant: { phone: "4035550111" } })] }],
    ]));
    const res = await request(await buildApp()).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.callPhone).toBe("+1 780 555 0100");
    const [sql] = callsMatching(queryMock, /FROM applications a WHERE a\.id::text/)[0]!;
    expect(String(sql)).toContain("(SELECT c.phone FROM contacts c WHERE c.id = a.contact_id) AS contact_phone");
  });

  it("falls back to the applicant's phone when the contact has none", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM applications a WHERE a\.id::text/, { rows: [detailsRow(null, { applicant: { phone: "4035550111" } })] }],
    ]));
    const res = await request(await buildApp()).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.callPhone).toBe("4035550111");
  });
});
