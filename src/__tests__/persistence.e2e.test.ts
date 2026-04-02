import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { signJwt } from "../auth/jwt";
import { CAPABILITIES } from "../auth/capabilities";
import { pool, runQuery } from "../db";
import { deps } from "../system/deps";

type LeadRow = {
  id: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  product_interest: string | null;
  source: string;
};

type CallRow = {
  id: string;
  phone_number: string;
  from_number: string | null;
  to_number: string | null;
  twilio_call_sid: string | null;
  direction: "outbound" | "inbound";
  status: string;
  duration_seconds: number | null;
  staff_user_id: string | null;
  crm_contact_id: string | null;
  application_id: string | null;
  error_code: string | null;
  error_message: string | null;
  recording_sid: string | null;
  recording_duration_seconds: number | null;
  created_at: Date;
  started_at: Date;
  ended_at: Date | null;
};

describe("server persistence e2e", () => {
  const authHeader = () =>
    `Bearer ${signJwt({ userId: "staff-user-1", role: "Admin", capabilities: [CAPABILITIES.CRM_READ] })}`;

  const leads: LeadRow[] = [];
  const calls: CallRow[] = [];

  beforeEach(() => {
    leads.length = 0;
    calls.length = 0;
    deps.db.ready = true;

    vi.spyOn(pool, "query").mockImplementation(async (text: any, params?: any[]) => {
      const sql = String(text).toLowerCase().replace(/\s+/g, " ").trim();

      if (sql.startsWith("insert into crm_leads")) {
        const row: LeadRow = {
          id: `lead-${leads.length + 1}`,
          email: (params?.[0] as string) ?? null,
          phone: (params?.[1] as string) ?? null,
          company_name: (params?.[2] as string) ?? null,
          product_interest: (params?.[3] as string) ?? null,
          source: (params?.[4] as string) ?? "crm_api",
        };
        leads.push(row);
        return { rows: [row] } as any;
      }

      if (sql.startsWith("insert into call_logs")) {
        const now = new Date();
        const row: CallRow = {
          id: params?.[0] as string,
          phone_number: params?.[1] as string,
          from_number: (params?.[2] as string) ?? null,
          to_number: (params?.[3] as string) ?? null,
          twilio_call_sid: (params?.[4] as string) ?? null,
          direction: params?.[5] as "outbound" | "inbound",
          status: params?.[6] as string,
          staff_user_id: (params?.[7] as string) ?? null,
          crm_contact_id: (params?.[8] as string) ?? null,
          application_id: (params?.[9] as string) ?? null,
          duration_seconds: null,
          error_code: null,
          error_message: null,
          recording_sid: null,
          recording_duration_seconds: null,
          created_at: now,
          started_at: now,
          ended_at: null,
        };
        calls.push(row);
        return { rows: [row] } as any;
      }

      if (sql.includes("from call_logs") && sql.includes("where id = $1") && sql.startsWith("select")) {
        return { rows: calls.filter((row) => row.id === params?.[0]) } as any;
      }

      if (sql.startsWith("update call_logs set")) {
        const id = params?.[params.length - 1] as string;
        const row = calls.find((entry) => entry.id === id);
        if (!row) {
          return { rows: [] } as any;
        }

        // update call_logs set status = $1, duration_seconds = $2 ... where id = $N
        const setClause = String(text).split("set")[1]?.split("where")[0] ?? "";
        const columns = setClause
          .split(",")
          .map((part) => part.trim())
          .map((part) => part.split("=")[0]?.trim())
          .filter(Boolean);

        columns.forEach((column, index) => {
          const value = params?.[index];
          (row as Record<string, unknown>)[column as string] = value;
        });

        return { rows: [row] } as any;
      }

      if (sql.startsWith("insert into audit_events")) {
        return { rows: [] } as any;
      }

      return { rows: [] } as any;
    });
  });

  it("persists a lead on createLead", async () => {
    const res = await request(app).post("/api/v1/crm/lead").set("Authorization", authHeader()).send({
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+15550001111",
      businessName: "Analytical Engines LLC",
      productType: "term_loan",
    });

    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.email).toBe("ada@example.com");
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body.data).toHaveProperty("id", leads[0]?.id);
  });

  it("rejects lead creation with invalid email", async () => {
    const res = await request(app).post("/api/v1/crm/lead").set("Authorization", authHeader()).send({
      name: "Ada Lovelace",
      email: "not-an-email",
      phone: "+15550001111",
    });

    expect(res.status).toBe(400);
    expect(leads).toHaveLength(0);
  });

  it("rejects lead creation when a required field is missing", async () => {
    const res = await request(app).post("/api/v1/crm/lead").set("Authorization", authHeader()).send({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(res.status).toBe(400);
    expect(leads).toHaveLength(0);
  });

  it("persists call creation and status updates", async () => {
    const start = await request(app)
      .post("/api/v1/call/start")
      .set("Authorization", authHeader())
      .send({ to: "+15550002222" });

    expect(start.status).toBe(200);
    expect(calls).toHaveLength(1);

    const callId = start.body?.data?.callId as string;
    const update = await request(app)
      .post(`/api/v1/call/${callId}/status`)
      .set("Authorization", authHeader())
      .send({ status: "completed", durationSeconds: 45 });

    expect(update.status).toBe(200);
    expect(calls[0]?.status).toBe("completed");
    expect(calls[0]?.duration_seconds).toBe(45);
  });
});
