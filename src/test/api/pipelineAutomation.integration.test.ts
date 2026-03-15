import type { Express } from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Role } from "../../auth/roles";
import { pool } from "../../db";
import { seedLenderProduct } from "../helpers/lenders";
import { createTestApp } from "../helpers/testApp";
import { seedUser } from "../helpers/users";

let app: Express;
let phoneCounter = 4200;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B3XYAAAAASUVORK5CYII=";

const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function loginWithRole(role: Role): Promise<{ token: string; userId: string }> {
  const phone = nextPhone();
  const email = `pipeline-${phone.replace(/\D/g, "")}@example.com`;
  const { id } = await seedUser({
    phoneNumber: phone,
    role,
    lenderId: null,
    email,
  });

  const res = await request(app).post("/api/auth/login").send({
    phone,
    code: "123456",
  });

  return { token: res.body.accessToken, userId: id };
}

async function createApplication(params: {
  token: string;
  productCategory: string;
}): Promise<{ id: string; pipelineState: string }> {
  const response = await request(app)
    .post("/api/applications")
    .set("Authorization", `Bearer ${params.token}`)
    .send({
      source: "client",
      country: "US",
      productCategory: params.productCategory,
      business: { legalName: "Automation Test Co" },
      applicant: {
        firstName: "Tara",
        lastName: "Ng",
        email: "tara.ng@example.com",
      },
      financialProfile: { revenue: 250000 },
      match: { partner: "direct" },
    });

  return {
    id: response.body.applicationId,
    pipelineState: response.body.pipelineState,
  };
}

describe("pipeline automation", () => {
  beforeAll(async () => {
    app = await createTestApp();
  });

  it("starts non-startup applications in RECEIVED", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    const created = await createApplication({ token, productCategory: "LOC" });
    expect(created.pipelineState).toBe("RECEIVED");
  });

  it("starts startup applications in STARTUP", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    const created = await createApplication({ token, productCategory: "startup" });
    expect(created.pipelineState).toBe("STARTUP");
  });

  it("moves to IN_REVIEW on first staff open", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    const created = await createApplication({ token, productCategory: "LOC" });

    const openRes = await request(app)
      .post(`/api/applications/${created.id}/open`)
      .set("Authorization", `Bearer ${token}`);
    expect(openRes.status).toBe(200);

    const state = await pool.query<{
      pipeline_state: string;
      first_opened_at: Date | null;
    }>("select pipeline_state, first_opened_at from applications where id = $1", [
      created.id,
    ]);
    expect(state.rows[0]?.pipeline_state).toBe("IN_REVIEW");
    expect(state.rows[0]?.first_opened_at).toBeInstanceOf(Date);
  });

  it("moves to DOCUMENTS_REQUIRED when any document is rejected", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    await seedLenderProduct({
      category: "LOC",
      country: "US",
      requiredDocuments: [{ type: "bank_statement", required: true }],
    });
    const created = await createApplication({ token, productCategory: "LOC" });

    const uploadRes = await request(app)
      .post(`/api/applications/${created.id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Bank Statement",
        documentType: "bank_statement",
        metadata: { fileName: "bank.png", mimeType: "image/png", size: 123 },
        content: PNG_BASE64,
      });
    expect(uploadRes.status).toBe(201);

    const rejectRes = await request(app)
      .post(`/api/documents/${uploadRes.body.document.documentId}/reject`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "Blurry document" });
    expect(rejectRes.status).toBe(200);

    const state = await pool.query<{ pipeline_state: string }>(
      "select pipeline_state from applications where id = $1",
      [created.id]
    );
    expect(state.rows[0]?.pipeline_state).toBe("DOCUMENTS_REQUIRED");
  });

  it("preserves immutable stage history", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    const created = await createApplication({ token, productCategory: "LOC" });

    await request(app)
      .post(`/api/applications/${created.id}/open`)
      .set("Authorization", `Bearer ${token}`);

    const events = await pool.query<{
      from_stage: string | null;
      to_stage: string;
      trigger: string;
    }>(
      `select from_stage, to_stage, trigger
       from application_stage_events
       where application_id = $1
       order by created_at asc`,
      [created.id]
    );

    expect(events.rows.length).toBe(2);
    expect(events.rows[0]).toMatchObject({
      from_stage: null,
      to_stage: "RECEIVED",
      trigger: "application_created",
    });
    expect(events.rows[1]).toMatchObject({
      from_stage: "RECEIVED",
      to_stage: "IN_REVIEW",
      trigger: "first_opened",
    });
  });

  it("prevents manual stage overrides", async () => {
    const { token } = await loginWithRole(ROLES.STAFF);
    const created = await createApplication({ token, productCategory: "LOC" });

    const overrideRes = await request(app)
      .post(`/api/applications/${created.id}/pipeline`)
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "OFF_TO_LENDER" });

    expect([403, 500]).toContain(overrideRes.status);
    expect(overrideRes.body).toMatchObject({
      error: expect.anything(),
    });
    const state = await pool.query<{ pipeline_state: string }>(
      "select pipeline_state from applications where id = $1",
      [created.id]
    );
    expect(state.rows[0]?.pipeline_state).toBe("RECEIVED");
  });
});
