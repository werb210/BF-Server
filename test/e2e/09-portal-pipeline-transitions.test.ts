// BF_SERVER_BLOCK_v161_TEST_SUITE_REFRESH_v1
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

// BF_SERVER_BLOCK_v579 - stage changes now also record previous_processing_stage and write
// stage history/events, so match the UPDATE that sets the stage for this application rather
// than one exact SQL string.
function expectStageSet(mock: { mock: { calls: any[][] } }, stage: string, applicationId: string) {
  const hit = mock.mock.calls.some((c: any[]) =>
    new RegExp(`UPDATE applications[\\s\\S]*pipeline_state = '${stage}'`).test(String(c[0])) &&
    Array.isArray(c[1]) && c[1][0] === applicationId);
  expect(hit).toBe(true);
}

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
      if (sql.includes("SELECT pipeline_state FROM applications") && (sql.includes("id::text") || sql.includes("id = $1"))) {
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
    expectStageSet(queryMock, "Documents Required", "app-2"); // BF_SERVER_BLOCK_v579
  });

  // BF_SERVER_BLOCK_v579 - v722/v468: accepting the last document never sends a file to a lender.
  // From Documents Required it goes to In Review, or back to Off to Lender if a package was
  // already sent. A file already In Review stays where it is.
  function acceptMocks(stage: string, sentPackages: number) {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE documents SET status = 'accepted'")) {
        return { rows: [{ id: "doc-2", document_type: "id", application_id: "app-3", status: "accepted" }], rowCount: 1 };
      }
      if (sql.includes("SELECT silo FROM applications")) return { rows: [{ silo: "BF" }], rowCount: 1 };
      if (sql.includes("count(*) AS total")) return { rows: [{ total: "2", accepted: "2" }], rowCount: 1 };
      if (sql.includes("FROM applications") && sql.includes("pipeline_state")) {
        return { rows: [{ pipeline_state: stage, previous_processing_stage: null }], rowCount: 1 };
      }
      if (sql.includes("FROM application_packages")) return { rows: [{ n: sentPackages }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }
  const stageUpdates = () => queryMock.mock.calls.filter((c: any[]) => /UPDATE applications SET pipeline_state = \$2/.test(String(c[0])));

  it("POST /api/portal/documents/:id/accept moves Documents Required to In Review when nothing was sent", async () => {
    acceptMocks("Documents Required", 0);
    const res = await request(app).post("/api/portal/documents/doc-2/accept").set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(stageUpdates().map((c: any[]) => c[1])).toEqual([["app-3", "In Review"]]);
  });

  it("POST /api/portal/documents/:id/accept returns a file already sent to Off to Lender", async () => {
    acceptMocks("Documents Required", 1);
    const res = await request(app).post("/api/portal/documents/doc-2/accept").set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(stageUpdates().map((c: any[]) => c[1])).toEqual([["app-3", "Off to Lender"]]);
  });

  it("POST /api/portal/documents/:id/accept leaves a file already In Review where it is", async () => {
    acceptMocks("In Review", 0);
    const res = await request(app).post("/api/portal/documents/doc-2/accept").set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(stageUpdates()).toHaveLength(0);
  });

  it("POST /api/portal/applications/:id/term-sheet advances Off to Lender to Offer", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT silo FROM applications")) return { rows: [{ silo: "BF" }], rowCount: 1 }; // BF_SERVER_BLOCK_v579 - v309 silo guard
      if (sql.includes("SELECT pipeline_state FROM applications") && (sql.includes("id::text") || sql.includes("id = $1"))) {
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
      .set("Authorization", authHeader)
      .field("lender_name", "Acme Lender")
      .attach("file", Buffer.from("fake-pdf"), "term-sheet.pdf");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, stage: "Offer" });
    expectStageSet(queryMock, "Offer", "app-4"); // BF_SERVER_BLOCK_v579
  });

});
