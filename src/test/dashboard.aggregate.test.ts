import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "../__tests__/helpers/otpAuth";

const app = buildAppWithApiRoutes();
let phoneCounter = 650;
const nextPhone = (): string => `+1415555${String(phoneCounter++).padStart(4, "0")}`;

describe("dashboard aggregates", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    await pool.query("delete from offers").catch(() => undefined);
    await pool.query("delete from lender_submissions");
    await pool.query("delete from documents");
    await pool.query("delete from applications");
    await pool.query("delete from users where id <> '00000000-0000-0000-0000-000000000001'");
  });

  it("returns v1 summary panels", async () => {
    const phone = nextPhone();
    await createUserAccount({ email: "admin-dashboard@test.com", phoneNumber: phone, role: ROLES.ADMIN });
    const login = await otpVerifyRequest(app, {
      phone,
      requestId: "dashboard-test",
      idempotencyKey: "dashboard-idem",
    });

    const response = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("pipelineOverview");
    expect(response.body.data).toHaveProperty("documentHealth");
    expect(response.body.data).toHaveProperty("lenderSubmissions");
    expect(response.body.data).toHaveProperty("offerActivity");
  });
});
