import { describe, expect, it, vi } from "vitest";

import * as db from "../../src/db.js";
import { answerBySql, callsMatching } from "../../src/__tests__/helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS
import { createLender } from "../../src/repositories/lenders.repo.js";

describe("createLender submission_method normalization", () => {
  it("writes EMAIL uppercase when payload has lowercase email method", async () => {
    vi.spyOn(db, "runQuery").mockImplementation(answerBySql([[/information_schema\.columns/, {
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
    }]]) as any);

    const dbQuery = vi.fn(answerBySql([[/INSERT INTO lenders/, { rows: [{ id: "lender-1" }] }]]));

    await createLender(
      { query: dbQuery },
      {
        name: "Lender X",
        country: "US",
        submission_method: "email",
        submission_email: "x@y.com",
      }
    );

    const inserts = callsMatching(dbQuery, /INSERT INTO lenders/);
    expect(inserts).toHaveLength(1);
    const [sql, values] = inserts[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO lenders");
    expect(values).toContain("EMAIL");
    expect(values).not.toContain("email");
  });
});
