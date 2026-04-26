import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, queryMock } = vi.hoisted(() => ({
  state: {
    appId: "app-1",
    company: null as any,
    contacts: [] as any[],
    applicationContacts: [] as any[],
    appCompanyId: null as string | null,
  },
  queryMock: vi.fn(),
}));

vi.mock("../../db.js", async () => ({
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
  },
  runQuery: queryMock,
  dbQuery: queryMock,
  query: queryMock,
  safeQuery: queryMock,
}));

describe("POST /api/client/applications/:token/submit normalized", () => {
  beforeEach(() => {
    vi.resetModules();
    state.company = null;
    state.contacts = [];
    state.applicationContacts = [];
    state.appCompanyId = null;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM applications") && sql.includes("WHERE id = $1")) {
        return { rows: [{ id: state.appId, silo: "BF", owner_user_id: "owner-1" }] };
      }
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE applications SET form_data")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM companies")) {
        const name = String(params?.[0] ?? "").toLowerCase();
        const silo = params?.[1];
        const row = state.company && state.company.name.toLowerCase() === name && state.company.silo === silo ? state.company : null;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO companies")) {
        state.company = { id: "co-1", name: params?.[1], silo: params?.[16], status: "prospect" };
        return { rows: [state.company] };
      }
      if (sql.includes("FROM contacts") && sql.includes("lower(email)")) {
        const [email, companyId, silo] = params ?? [];
        const row = state.contacts.find((c) => c.email?.toLowerCase() === String(email).toLowerCase() && c.company_id === companyId && c.silo === silo);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO contacts")) {
        const id = `ct-${state.contacts.length + 1}`;
        const row = {
          id,
          first_name: params?.[2],
          last_name: params?.[3],
          email: params?.[4],
          role: params?.[14],
          is_primary_applicant: params?.[15],
          company_id: params?.[16],
          silo: params?.[17],
        };
        state.contacts.push(row);
        return { rows: [row] };
      }
      if (sql.includes("INSERT INTO application_contacts")) {
        const [applicationId, contactId, role] = params ?? [];
        const exists = state.applicationContacts.some((x) => x.applicationId === applicationId && x.contactId === contactId && x.role === role);
        if (!exists) state.applicationContacts.push({ applicationId, contactId, role });
        return { rows: [] };
      }
      if (sql.includes("UPDATE applications SET company_id")) {
        state.appCompanyId = params?.[0] ?? null;
        return { rows: [] };
      }
      return { rows: [] };
    });
    process.env.JWT_SECRET = "test-secret-12345";
    process.env.BF_SSN_ENCRYPTION_FALLBACK = "1";
  });

  async function app() {
    const router = (await import("../client/v1Applications.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/client", router);
    return a;
  }

  const body = {
    normalized: {
      company: { name: "_E2E_Smoke_Co" },
      applicant: { first_name: "Smoke", last_name: "Tester", email: "smoke+applicant@example.com", ssn: "123-456-789" },
      partner: { first_name: "Smoke", last_name: "Partner", email: "smoke+partner@example.com", ssn: "987-654-321" },
    },
  };

  it("fans out normalized data idempotently and creates new contact for new applicant email", async () => {
    const client = await app();
    const res1 = await request(client).post(`/api/client/applications/${state.appId}/submit`).send(body);
    expect(res1.status).toBe(200);
    expect(state.company).toBeTruthy();
    expect(state.contacts.length).toBe(2);
    expect(state.applicationContacts.length).toBe(2);
    expect(state.appCompanyId).toBe("co-1");

    const res2 = await request(client).post(`/api/client/applications/${state.appId}/submit`).send(body);
    expect(res2.status).toBe(200);
    expect(state.contacts.length).toBe(2);
    expect(state.applicationContacts.length).toBe(2);

    const body2 = {
      normalized: {
        company: { name: "_E2E_Smoke_Co" },
        applicant: { first_name: "Smoke", last_name: "Tester", email: "smoke+new@example.com" },
      },
    };
    const res3 = await request(client).post(`/api/client/applications/${state.appId}/submit`).send(body2);
    expect(res3.status).toBe(200);
    expect(state.company.id).toBe("co-1");
    expect(state.contacts.length).toBe(3);
  });
});
