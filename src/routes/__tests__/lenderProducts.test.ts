import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";
import { pool } from "../../db";

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

describe("GET /api/client/lender-products", () => {
  beforeEach(() => {
    mockPool.query.mockResolvedValue({
      rows: [
        {
          id: "product-1",
          category: "TERM",
          term_min: 6,
          term_max: 24,
          country: "US",
          name: "Term Product",
        },
      ],
    });
  });

  it("returns 200 with an array payload", async () => {
    const response = await request(app).get("/api/client/lender-products");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
