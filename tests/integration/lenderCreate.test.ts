import { describe, expect, it, vi } from "vitest";

import * as db from "../../src/db.js";
import { createLender } from "../../src/repositories/lenders.repo.js";

describe("createLender submission_method normalization", () => {
  it("writes EMAIL uppercase when payload has lowercase email method", async () => {
    vi.spyOn(db, "runQuery").mockResolvedValueOnce({
      rows: [
        { column_name: "id" },
        { column_name: "name" },
        { column_name: "country" },
        { column_name: "submission_method" },
        { column_name: "submission_email" },
        { column_name: "api_config" },
        { column_name: "submission_config" },
        { column_name: "status" },
        { column_name: "active" },
        { column_name: "created_at" },
        { column_name: "updated_at" },
      ],
    } as any);

    const dbQuery = vi.fn().mockResolvedValue({ rows: [{ id: "lender-1" }] });

    await createLender(
      { query: dbQuery },
      {
        name: "Lender X",
        country: "US",
        submission_method: "email",
        submission_email: "x@y.com",
      }
    );

    const [sql, values] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO lenders");
    expect(values).toContain("EMAIL");
    expect(values).not.toContain("email");
  });
});
