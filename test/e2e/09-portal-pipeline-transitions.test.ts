import request from "supertest";
import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/applications/applications.repo.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/modules/applications/applications.repo.js")>(
    "../../src/modules/applications/applications.repo.js"
  );
  return {
    ...actual,
    findApplicationById: vi.fn(),
    listDocumentsByApplicationId: vi.fn(),
    findActiveDocumentVersion: vi.fn(),
  };
});

import { createServer } from "../../src/server/createServer";
import { generateTestToken } from "../utils/token";
import { deps } from "../../src/system/deps.js";
import { markReady } from "../../src/startupState.js";

describe("Portal pipeline auto transitions", () => {
  let app: Express;
  let authHeader: string;
  const queryMock = vi.fn();

  beforeAll(() => {
    app = createServer();
    authHeader = `Bearer ${generateTestToken({ role: "Staff" })}`;
  });

  beforeEach(() => {
    queryMock.mockReset();
    deps.db.ready = true;
    deps.db.client = { query: queryMock } as any;
    markReady();
  });

  it("POST /api/portal/documents/:id/reject advances application to Documents Required", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE documents SET status = 'rejected'")) {
        return {
          rows: [{ id: "doc-1", document_type: "bank_statement", application_id: "app-2", status: "rejected" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT pipeline_state FROM applications WHERE id = $1")) {
        return { rows: [{ pipeline_state: "In Review" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE applications SET pipeline_state = 'Documents Required'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO application_stage_events")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT u.phone_number AS phone_number")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/api/portal/documents/doc-1/reject")
      .set("Authorization", authHeader)
      .send({ reason: "blurry" });

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE applications SET pipeline_state = 'Documents Required'"),
      ["app-2"],
    );
  });

  it("POST /api/portal/documents/:id/accept advances to Off to Lender when last pending doc is accepted", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE documents SET status = 'accepted'")) {
        return {
          rows: [{ id: "doc-2", document_type: "id", application_id: "app-3", status: "accepted" }],
          rowCount: 1,
        };
      }
      if (sql.includes("count(*) AS total")) {
        return { rows: [{ total: "2", accepted: "2" }], rowCount: 1 };
      }
      if (sql.includes("SELECT pipeline_state FROM applications WHERE id = $1")) {
        return { rows: [{ pipeline_state: "In Review" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE applications SET pipeline_state = 'Off to Lender'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO application_stage_events")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/api/portal/documents/doc-2/accept")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE applications SET pipeline_state = 'Off to Lender'"),
      ["app-3"],
    );
  });

  it("POST /api/portal/applications/:id/term-sheet advances Off to Lender to Offer", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT pipeline_state FROM applications WHERE id = $1")) {
        return { rows: [{ pipeline_state: "Off to Lender" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE applications SET pipeline_state = 'Offer'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO application_stage_events")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/api/portal/applications/app-4/term-sheet")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stage: "Offer" });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE applications SET pipeline_state = 'Offer'"),
      ["app-4"],
    );
  });

});
