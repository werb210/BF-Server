// BF_SERVER_DRAFT_NOT_FOUND_v1
import { describe, expect, it } from "vitest";
import { draftErrorResponse } from "../../modules/o365/draftErrors.js";

const ITEM_NOT_FOUND =
  '{"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store."}}';

describe("draft error mapping", () => {
  it("reports a vanished draft as 409 draft_not_found", () => {
    const mapped = draftErrorResponse(404, ITEM_NOT_FOUND);
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.body.error).toBe("draft_not_found");
  });

  it("recognises ErrorItemNotFound even when the status is not 404", () => {
    expect(draftErrorResponse(500, ITEM_NOT_FOUND).body.error).toBe("draft_not_found");
  });

  it("still reports a scope problem as 412", () => {
    expect(draftErrorResponse(403, "forbidden").httpStatus).toBe(412);
    expect(draftErrorResponse(401, "unauthorized").body.error).toBe("o365_insufficient_scope");
  });

  it("leaves every other Graph failure as 502", () => {
    const mapped = draftErrorResponse(500, "gateway exploded");
    expect(mapped.httpStatus).toBe(502);
    expect(mapped.body.error).toBe("graph_draft_failed");
  });

  it("passes the Graph detail through untouched", () => {
    expect(draftErrorResponse(404, ITEM_NOT_FOUND).body.detail).toBe(ITEM_NOT_FOUND);
  });
});
