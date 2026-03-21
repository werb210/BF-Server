import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";
import { pool } from "../../db";
import { ROLES } from "../../auth/roles";
import { signAccessToken } from "../../auth/jwt";

vi.mock("../../services/lenderProductRequirementsService", () => ({
  ensureSeedRequirementsForProduct: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../db", () => {
  const query = vi.fn();
  return {
    pool: { query },
    db: { query },
    checkDb: vi.fn(),
  };
});

const app = buildAppWithApiRoutes();

const mockPool = pool as unknown as { query: vi.Mock };

const userRow = {
  id: "user-1",
  email: "admin@example.com",
  phoneNumber: "15555550123",
  phoneVerified: true,
  role: ROLES.ADMIN,
  silo: "default",
  lenderId: null,
  status: "ACTIVE",
  active: true,
  isActive: true,
  disabled: false,
  lockedUntil: null,
  tokenVersion: 0,
};

const lenderColumns = [
  "id",
  "name",
  "country",
  "submission_method",
  "active",
  "status",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
  "website",
  "submission_email",
  "api_config",
  "submission_config",
  "created_at",
  "updated_at",
].map((column_name) => ({ column_name }));

const lenderProductColumns = [
  "id",
  "lender_id",
  "name",
  "category",
  "country",
  "rate_type",
  "interest_min",
  "interest_max",
  "term_min",
  "term_max",
  "term_unit",
  "active",
  "required_documents",
  "created_at",
  "updated_at",
].map((column_name) => ({ column_name }));

describe("GET /api/lenders", () => {
  beforeEach(() => {
    mockPool.query.mockImplementation((query: string) => {
      if (query.toLowerCase().includes("from users")) {
        return Promise.resolve({
          rows: [userRow],
        });
      }
      return Promise.resolve({
        rows: [
          {
            id: "lender-1",
            name: "Example Lender",
            country: "US",
            submission_method: ["email"],
            products: [],
          },
        ],
      });
    });
  });

  it("returns 200 with an array payload", async () => {
    const token = signAccessToken({
      sub: "user-1",
      role: ROLES.ADMIN,
      tokenVersion: 0,
      silo: "default",
    });
    const response = await request(app)
      .get("/api/lenders")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe("POST /api/lenders", () => {
  beforeEach(() => {
    mockPool.query.mockImplementation((query: string, values?: unknown[]) => {
      const lower = query.toLowerCase();
      if (lower.includes("from users")) {
        return Promise.resolve({ rows: [userRow] });
      }
      if (lower.includes("information_schema.columns")) {
        const tableName = Array.isArray(values) ? String(values[0]) : "";
        if (tableName === "lender_products") {
          return Promise.resolve({ rows: lenderProductColumns });
        }
        return Promise.resolve({ rows: lenderColumns });
      }
      if (lower.includes("insert into lenders")) {
        return Promise.resolve({
          rows: [
            {
              id: "lender-1",
              name: "Active Lender",
              country: "US",
              status: "ACTIVE",
              active: true,
              primary_contact_name: "Alex Smith",
              primary_contact_email: "alex@example.com",
              primary_contact_phone: "15555550000",
              submission_method: "email",
              submission_email: "submissions@lender.com",
              api_config: null,
              website: "https://lender.com",
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("creates an active lender with ACTIVE status", async () => {
    const token = signAccessToken({
      sub: userRow.id,
      role: ROLES.ADMIN,
      tokenVersion: 0,
      silo: "default",
    });

    const response = await request(app)
      .post("/api/lenders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Active Lender",
        country: "US",
        submissionMethod: "email",
        submissionEmail: "submissions@lender.com",
        active: true,
        contact: {
          name: "Alex Smith",
          email: "alex@example.com",
          phone: "15555550000",
        },
        website: "https://lender.com",
      });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("ACTIVE");

    const insertCall = mockPool.query.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("insert into lenders")
    );
    expect(insertCall?.[1]).toEqual(expect.arrayContaining(["ACTIVE"]));
  });
});

describe("GET /api/lenders/:id", () => {
  beforeEach(() => {
    mockPool.query.mockImplementation((query: string, values?: unknown[]) => {
      const lower = query.toLowerCase();
      if (lower.includes("from users")) {
        return Promise.resolve({ rows: [userRow] });
      }
      if (lower.includes("information_schema.columns")) {
        return Promise.resolve({ rows: lenderColumns });
      }
      if (lower.includes("from lenders") && lower.includes("where id")) {
        return Promise.resolve({
          rows: [
            {
              id: "lender-1",
              name: "Example Lender",
              status: "ACTIVE",
              country: "US",
              primary_contact_name: "Jamie Doe",
              primary_contact_email: "jamie@example.com",
              primary_contact_phone: "15555550111",
              submission_method: "email",
              submission_email: "submissions@example.com",
              api_config: null,
              submission_config: null,
              website: "https://lender.example",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("returns lender details for edit modal", async () => {
    const token = signAccessToken({
      sub: userRow.id,
      role: ROLES.ADMIN,
      tokenVersion: 0,
      silo: "default",
    });

    const response = await request(app)
      .get("/api/lenders/lender-1")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: "lender-1",
      name: "Example Lender",
      status: "ACTIVE",
      active: true,
      country: "US",
      email: null,
      primary_contact_name: "Jamie Doe",
      primary_contact_email: "jamie@example.com",
      primary_contact_phone: "15555550111",
      contact_name: "Jamie Doe",
      contact_email: "jamie@example.com",
      contact_phone: "15555550111",
      website: "https://lender.example",
      submission_method: "email",
      submission_email: "submissions@example.com",
      api_config: null,
      submission_config: null,
      created_at: null,
      updated_at: null,
    });
  });
});

describe("POST /api/lender-products", () => {
  beforeEach(() => {
    mockPool.query.mockImplementation((query: string, values?: unknown[]) => {
      const lower = query.toLowerCase();
      if (lower.includes("from users")) {
        return Promise.resolve({ rows: [userRow] });
      }
      if (lower.includes("information_schema.columns")) {
        const tableName = Array.isArray(values) ? String(values[0]) : "";
        if (tableName === "lender_products") {
          return Promise.resolve({ rows: lenderProductColumns });
        }
        return Promise.resolve({ rows: lenderColumns });
      }
      if (lower.includes("from lenders") && lower.includes("where id")) {
        return Promise.resolve({
          rows: [
            {
              id: "lender-1",
              name: "Example Lender",
              status: "ACTIVE",
              country: "US",
            },
          ],
        });
      }
      if (lower.includes("insert into lender_products")) {
        return Promise.resolve({
          rows: [
            {
              id: "product-1",
              lender_id: "lender-1",
              name: "Working Capital",
              category: "LOC",
              country: "US",
              rate_type: "FIXED",
              interest_min: "8.5",
              interest_max: "12.5",
              term_min: 6,
              term_max: 24,
              term_unit: "MONTHS",
              active: true,
              required_documents: [],
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("persists a lender product when lender is active", async () => {
    const token = signAccessToken({
      sub: userRow.id,
      role: ROLES.ADMIN,
      tokenVersion: 0,
      silo: "default",
    });

    const response = await request(app)
      .post("/api/lender-products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        lenderId: "lender-1",
        name: "Working Capital",
        active: true,
        required_documents: [],
        category: "LOC",
        country: "US",
        rate_type: "FIXED",
        interest_min: 8.5,
        interest_max: 12.5,
        term_min: 6,
        term_max: 24,
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("product-1");

    const insertCall = mockPool.query.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("insert into lender_products")
    );
    expect(insertCall).toBeTruthy();
  });
});
