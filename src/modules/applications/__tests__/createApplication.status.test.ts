import { describe, expect, it, vi } from "vitest";
import { statusFromPipeline, ApplicationStage } from "../pipelineState.js";

describe("statusFromPipeline (Block 14)", () => {
  it("maps RECEIVED title-case to constraint-valid uppercase key", () => {
    expect(statusFromPipeline(ApplicationStage.RECEIVED)).toBe("RECEIVED");
  });
  it("maps every pipeline state to a constraint-allowed status", () => {
    const allowed = new Set([
      "RECEIVED", "DOCUMENTS_REQUIRED", "IN_REVIEW", "STARTUP",
      "OFF_TO_LENDER", "SUBMITTED_TO_LENDER", "ACCEPTED", "DECLINED",
    ]);
    for (const stage of Object.values(ApplicationStage)) {
      const status = statusFromPipeline(stage as string);
      expect(allowed.has(status)).toBe(true);
    }
  });
});

describe("createApplication INSERT shape (Block 14)", () => {
  it("includes status column with uppercase constraint-valid value", async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ id: "app-id", owner_user_id: "u", name: "n", metadata: {}, product_type: "standard",
        product_category: "standard", pipeline_state: "Received", current_stage: "Received",
        processing_stage: "received", lender_id: null, lender_product_id: null, requested_amount: null,
        first_opened_at: null, ocr_completed_at: null, banking_completed_at: null,
        credit_summary_completed_at: null, startup_flag: false, created_at: new Date(), updated_at: new Date() }],
    });

    vi.doMock("../../../db.js", () => ({
      pool: { query: queryMock },
      runQuery: queryMock,
    }));

    const { createApplication } = await import("../applications.repo.js");
    await createApplication({
      ownerUserId: "00000000-0000-0000-0000-000000000001",
      name: "Test draft",
      metadata: {},
      productType: "standard",
      productCategory: "standard",
      source: "client_direct",
    } as any);

    expect(queryMock).toHaveBeenCalled();
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain("status");
    // The status param is the 8th positional value (after id, owner, name, metadata, product_type, category, pipeline_state)
    // Since pipeline_state and current_stage share $7, the next index is $8 = status.
    expect(params).toContain("RECEIVED");
  });
});
